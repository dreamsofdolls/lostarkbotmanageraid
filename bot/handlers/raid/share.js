/**
 * handlers/raid/share.js
 * /raid-share: Manager-only roster sharing. Grant a viewer all of
 * your rosters with edit or view permission. Grantee gets read+write
 * via /raid-status, /raid-set, /raid-task, and the text parser; the
 * owner keeps exclusive rights on /raid-add-roster, /raid-edit-roster,
 * /raid-remove-roster, /raid-auto-manage. Backed by the RosterShare
 * collection (one grant doc per owner↔grantee pair).
 */

const RosterShare = require("../../models/RosterShare");
const User = require("../../models/user");
const { isManagerId } = require("../../services/access/manager");
// tPick, not t: some descriptions here are variant pools; non-pool keys pass through.
const { tPick: t, getUserLanguage } = require("../../services/i18n");
const {
  NoticeKind,
  buildKeyedNotice,
  buildManagerOnlyField,
  deferEphemeralReply,
  editEmbed,
  editNotice,
  replyNotice,
} = require("../../utils/raid/common/shared");

// A notice whose copy lives at `share.<stem>{Title,Description,Tip}`.
function shareNotice(kind, stem, lang, vars) {
  return buildKeyedNotice({ kind, keyBase: `share.${stem}`, lang, vars });
}

function ownerLabel(userDoc, fallbackId) {
  return (
    userDoc?.discordDisplayName ||
    userDoc?.discordGlobalName ||
    userDoc?.discordUsername ||
    fallbackId ||
    "(unknown user)"
  );
}

// Localize a stored access level ("edit" / "view") into the viewer's
// language so all 3 callers (grant update description, list outgoing/
// incoming rows) render the access badge consistently.
function localizedAccessLevel(level, lang) {
  return t(`share.accessLevel.${level || "edit"}`, lang);
}

/**
 * Build the /raid-share command handler factory.
 * @param {object} deps - injected dependencies
 * @param {Function} deps.EmbedBuilder - discord.js EmbedBuilder
 * @param {object} deps.UI - shared color/icon palette
 * @returns {{handleRaidShareCommand: Function}} single dispatch entry
 *   that internally branches on the `grant`/`revoke`/`list` subcommand
 */
function createRaidShareCommand(deps) {
  const { EmbedBuilder, UI } = deps;
  const replyShareNotice = (interaction, options) => replyNotice(interaction, EmbedBuilder, options);
  const editShareNotice = (interaction, options) => editNotice(interaction, EmbedBuilder, options);

  // ── /raid-share grant target:@B [permission:view|edit] ──────────────
  // Manager-only (env RAID_MANAGER_ID). Upserts a RosterShare so a
  // second grant on the same target overwrites accessLevel rather than
  // creating a duplicate document.
  async function handleGrant(interaction, lang) {
    const target = interaction.options.getUser("target", true);
    const permission = interaction.options.getString("permission") || "edit";

    if (target.bot) {
      await replyShareNotice(interaction, shareNotice(NoticeKind.INPUT, "grant.botTarget", lang));
      return;
    }
    if (target.id === interaction.user.id) {
      await replyShareNotice(interaction, shareNotice(NoticeKind.INPUT, "grant.selfTarget", lang));
      return;
    }

    await deferEphemeralReply(interaction);

    // Upsert: same (owner, grantee) pair always maps to one document.
    // Re-running grant with a new permission level swaps it in place.
    const existing = await RosterShare.findOne({
      ownerDiscordId: interaction.user.id,
      granteeDiscordId: target.id,
    });
    const previousLevel = existing?.accessLevel || null;

    await RosterShare.updateOne(
      {
        ownerDiscordId: interaction.user.id,
        granteeDiscordId: target.id,
      },
      {
        $set: { accessLevel: permission },
        $setOnInsert: {
          ownerDiscordId: interaction.user.id,
          granteeDiscordId: target.id,
          createdAt: new Date(),
          grantedBy: interaction.user.id,
        },
      },
      { upsert: true },
    );

    const description = previousLevel
      ? t("share.grant.descriptionUpdate", lang, {
        target: target.id,
        previous: localizedAccessLevel(previousLevel, lang),
        permission: localizedAccessLevel(permission, lang),
      })
      : t("share.grant.descriptionNew", lang, { target: target.id });

    await editShareNotice(interaction, {
      kind: NoticeKind.DONE,
      title: t(previousLevel ? "share.grant.successTitleUpdate" : "share.grant.successTitleNew", lang),
      description,
      fields: [{
        name: t("share.grant.accessField", lang),
        value: t(`share.grant.access.${permission}`, lang),
        inline: false,
      }],
      tip: t("share.grant.revokeTip", lang),
    });
  }

  // ── /raid-share revoke target:@B ────────────────────────────────────
  async function handleRevoke(interaction, lang) {
    const target = interaction.options.getUser("target", true);

    await deferEphemeralReply(interaction);

    const result = await RosterShare.deleteOne({
      ownerDiscordId: interaction.user.id,
      granteeDiscordId: target.id,
    });

    if (result.deletedCount === 0) {
      await editShareNotice(interaction, shareNotice(NoticeKind.INPUT, "revoke.noShare", lang, { target: target.id }));
      return;
    }

    await editShareNotice(interaction, shareNotice(NoticeKind.DONE, "revoke.success", lang, { target: target.id }));
  }

  // ── /raid-share list [direction:in|out|both] ────────────────────────
  // Default direction = both. Outgoing = shares cậu đã grant (cậu = A).
  // Incoming = shares cậu đang nhận (cậu = B).
  async function handleList(interaction, lang) {
    const direction = interaction.options.getString("direction") || "both";

    await deferEphemeralReply(interaction);

    const showOutgoing = direction === "out" || direction === "both";
    const showIncoming = direction === "in" || direction === "both";

    const [outgoing, incoming] = await Promise.all([
      showOutgoing
        ? RosterShare.find({ ownerDiscordId: interaction.user.id }).lean()
        : Promise.resolve([]),
      showIncoming
        ? RosterShare.find({ granteeDiscordId: interaction.user.id }).lean()
        : Promise.resolve([]),
    ]);

    // Resolve owner display labels for incoming shares so the embed shows
    // `@AliceTheManager` instead of a raw discord ID.
    const incomingOwnerIds = incoming.map((s) => s.ownerDiscordId);
    const incomingOwnerDocs = incomingOwnerIds.length > 0
      ? await User.find({ discordId: { $in: incomingOwnerIds } }).lean()
      : [];
    const incomingOwnerById = new Map(
      incomingOwnerDocs.map((u) => [u.discordId, u]),
    );

    const lines = [];

    if (showOutgoing) {
      lines.push(t("share.list.outgoingHeader", lang));
      if (outgoing.length === 0) {
        lines.push(t("share.list.outgoingEmpty", lang));
      } else {
        for (const share of outgoing) {
          const suspended = !isManagerId(interaction.user.id);
          const tag = suspended ? t("share.list.outgoingSuspendedTag", lang) : "";
          const accessText = localizedAccessLevel(share.accessLevel, lang);
          lines.push(
            `• <@${share.granteeDiscordId}> · \`${accessText}\`${tag}`,
          );
        }
      }
    }

    if (showOutgoing && showIncoming) lines.push("");

    if (showIncoming) {
      lines.push(t("share.list.incomingHeader", lang));
      if (incoming.length === 0) {
        lines.push(t("share.list.incomingEmpty", lang));
      } else {
        for (const share of incoming) {
          const ownerDoc = incomingOwnerById.get(share.ownerDiscordId);
          const label = ownerLabel(ownerDoc, share.ownerDiscordId);
          const suspended = !isManagerId(share.ownerDiscordId);
          const tag = suspended ? t("share.list.incomingSuspendedTag", lang) : "";
          const accessText = localizedAccessLevel(share.accessLevel, lang);
          lines.push(
            `• ${label} (<@${share.ownerDiscordId}>) · \`${accessText}\`${tag}`,
          );
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(t("share.list.title", lang))
      .setDescription(lines.join("\n"))
      .setFooter({ text: t("share.list.footer", lang) });

    await editEmbed(interaction, embed);
  }

  // Top-level dispatch. Permission gate (Manager-only) applies to
  // grant/revoke. List is open to everyone so a regular user can see
  // who has shared rosters with them.
  const managerOnlySubcommands = new Set(["grant", "revoke"]);
  const subcommandHandlers = new Map([
    ["grant", handleGrant],
    ["revoke", handleRevoke],
    ["list", handleList],
  ]);

  async function handleRaidShareCommand(interaction) {
    // Resolve invoker's locale once at command entry; every reply on
    // /raid-share is ephemeral to the invoker, so this lang threads
    // through every branch without any clicker-vs-owner split.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const sub = interaction.options.getSubcommand();

    if (managerOnlySubcommands.has(sub) && !isManagerId(interaction.user.id)) {
      await replyShareNotice(interaction, {
        ...shareNotice(NoticeKind.GUARD, "auth.managerOnly", lang),
        fields: [buildManagerOnlyField(lang)],
      });
      return;
    }

    const handler = subcommandHandlers.get(sub);
    if (handler) return handler(interaction, lang);

    // Only a client still holding an older command definition can send a
    // subcommand the bot no longer has.
    await replyShareNotice(interaction, shareNotice(NoticeKind.EXPIRED, "unknownSubcommand", lang, { sub }));
  }

  return { handleRaidShareCommand };
}

module.exports = { createRaidShareCommand };
