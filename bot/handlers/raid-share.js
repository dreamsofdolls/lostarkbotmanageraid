const RosterShare = require("../models/RosterShare");
const User = require("../models/user");
const { isManagerId } = require("../services/manager");
const { t, getUserLanguage } = require("../services/i18n");

function buildAlertEmbed({ EmbedBuilder, UI, type = "info", title, description, footer }) {
  const colorKey = type === "error" ? "danger" : type === "success" ? "success" : "neutral";
  const embed = new EmbedBuilder()
    .setColor(UI.colors[colorKey] || UI.colors.neutral)
    .setTitle(title)
    .setDescription(description);
  if (footer) embed.setFooter({ text: footer });
  return embed;
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

function createRaidShareCommand(deps) {
  const { EmbedBuilder, MessageFlags, UI } = deps;

  // ── /raid-share grant target:@B [permission:view|edit] ──────────────
  // Manager-only (env RAID_MANAGER_ID). Upserts a RosterShare so a
  // second grant on the same target overwrites accessLevel rather than
  // creating a duplicate document.
  async function handleGrant(interaction, lang) {
    const target = interaction.options.getUser("target", true);
    const permission = interaction.options.getString("permission") || "edit";

    if (target.bot) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          EmbedBuilder,
          UI,
          type: "error",
          title: t("share.grant.botTargetTitle", lang),
          description: t("share.grant.botTargetDescription", lang),
        })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (target.id === interaction.user.id) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          EmbedBuilder,
          UI,
          type: "error",
          title: t("share.grant.selfTargetTitle", lang),
          description: t("share.grant.selfTargetDescription", lang),
        })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    const isUpdate = !!previousLevel;
    const title = isUpdate
      ? t("share.grant.successTitleUpdate", lang)
      : t("share.grant.successTitleNew", lang);
    let desc;
    if (isUpdate) {
      desc = t("share.grant.descriptionUpdate", lang, {
        target: target.id,
        previous: localizedAccessLevel(previousLevel, lang),
        permission: localizedAccessLevel(permission, lang),
      });
    } else if (permission === "edit") {
      desc = t("share.grant.descriptionNewEdit", lang, { target: target.id });
    } else {
      desc = t("share.grant.descriptionNewView", lang, { target: target.id });
    }

    await interaction.editReply({
      embeds: [buildAlertEmbed({
        EmbedBuilder,
        UI,
        type: "success",
        title,
        description: desc,
        footer: t("share.grant.footer", lang),
      })],
    });
  }

  // ── /raid-share revoke target:@B ────────────────────────────────────
  async function handleRevoke(interaction, lang) {
    const target = interaction.options.getUser("target", true);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await RosterShare.deleteOne({
      ownerDiscordId: interaction.user.id,
      granteeDiscordId: target.id,
    });

    if (result.deletedCount === 0) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          EmbedBuilder,
          UI,
          type: "info",
          title: t("share.revoke.noShareTitle", lang),
          description: t("share.revoke.noShareDescription", lang, { target: target.id }),
        })],
      });
      return;
    }

    await interaction.editReply({
      embeds: [buildAlertEmbed({
        EmbedBuilder,
        UI,
        type: "success",
        title: t("share.revoke.successTitle", lang),
        description: t("share.revoke.successDescription", lang, { target: target.id }),
      })],
    });
  }

  // ── /raid-share list [direction:in|out|both] ────────────────────────
  // Default direction = both. Outgoing = shares cậu đã grant (cậu = A).
  // Incoming = shares cậu đang nhận (cậu = B).
  async function handleList(interaction, lang) {
    const direction = interaction.options.getString("direction") || "both";

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    await interaction.editReply({ embeds: [embed] });
  }

  // Top-level dispatch. Permission gate (Manager-only) applies to
  // grant/revoke. List is open to everyone so a regular user can see
  // who has shared rosters with them.
  async function handleRaidShareCommand(interaction) {
    // Resolve invoker's locale once at command entry; every reply on
    // /raid-share is ephemeral to the invoker, so this lang threads
    // through every branch without any clicker-vs-owner split.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const sub = interaction.options.getSubcommand();

    if ((sub === "grant" || sub === "revoke") && !isManagerId(interaction.user.id)) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          EmbedBuilder,
          UI,
          type: "error",
          title: t("share.auth.managerOnlyTitle", lang),
          description: t("share.auth.managerOnlyDescription", lang),
        })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "grant") return handleGrant(interaction, lang);
    if (sub === "revoke") return handleRevoke(interaction, lang);
    if (sub === "list") return handleList(interaction, lang);

    await interaction.reply({
      content: `Unknown subcommand: ${sub}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  return { handleRaidShareCommand };
}

module.exports = { createRaidShareCommand };
