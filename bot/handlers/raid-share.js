const RosterShare = require("../models/RosterShare");
const User = require("../models/user");
const { isManagerId } = require("../services/manager");

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

function createRaidShareCommand(deps) {
  const { EmbedBuilder, MessageFlags, UI } = deps;

  // ── /raid-share grant target:@B [permission:view|edit] ──────────────
  // Manager-only (env RAID_MANAGER_ID). Upserts a RosterShare so a
  // second grant on the same target overwrites accessLevel rather than
  // creating a duplicate document.
  async function handleGrant(interaction) {
    const target = interaction.options.getUser("target", true);
    const permission = interaction.options.getString("permission") || "edit";

    if (target.bot) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          EmbedBuilder,
          UI,
          type: "error",
          title: "Không share cho bot",
          description: "Target phải là một Discord user thật, không phải bot.",
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
          title: "Không share cho chính mình",
          description: "Target không thể là chính cậu - rosters của cậu thì cậu vẫn quản lý mà~",
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

    const verb = previousLevel ? "Cập nhật share" : "Đã share";
    const desc = previousLevel
      ? `Đổi quyền cho <@${target.id}> từ \`${previousLevel}\` → \`${permission}\`. ` +
        `Lần kế tiếp họ chạy /raid-status hoặc /raid-set, autocomplete sẽ phản ánh quyền mới.`
      : `Từ giờ <@${target.id}> sẽ thấy mọi roster của cậu trong /raid-status và ` +
        `(với quyền \`${permission}\`) có thể ${permission === "edit" ? "**update progress** qua /raid-set, /raid-task, text parser" : "**xem read-only** không update được"}. ` +
        `Cậu có thể \`/raid-share revoke\` bất cứ lúc nào để rút quyền.`;

    await interaction.editReply({
      embeds: [buildAlertEmbed({
        EmbedBuilder,
        UI,
        type: "success",
        title: `${verb} thành công`,
        description: desc,
        footer: `Manager-only command · only RAID_MANAGER_ID accounts can /raid-share`,
      })],
    });
  }

  // ── /raid-share revoke target:@B ────────────────────────────────────
  async function handleRevoke(interaction) {
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
          title: "Không có share nào để rút",
          description: `<@${target.id}> chưa được cậu share roster. Không có gì để revoke.`,
        })],
      });
      return;
    }

    await interaction.editReply({
      embeds: [buildAlertEmbed({
        EmbedBuilder,
        UI,
        type: "success",
        title: "Đã rút share",
        description:
          `<@${target.id}> sẽ không còn thấy roster của cậu trong /raid-status nữa. ` +
          `Lần kế tiếp họ chạy command, view sẽ revert về roster của riêng họ.`,
      })],
    });
  }

  // ── /raid-share list [direction:in|out|both] ────────────────────────
  // Default direction = both. Outgoing = shares cậu đã grant (cậu = A).
  // Incoming = shares cậu đang nhận (cậu = B).
  async function handleList(interaction) {
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
      lines.push("**📤 Outgoing shares** (cậu đã grant cho người khác):");
      if (outgoing.length === 0) {
        lines.push("_Chưa share roster cho ai._");
      } else {
        for (const share of outgoing) {
          const suspended = !isManagerId(interaction.user.id);
          const tag = suspended ? " ⚠️ (cậu hết Manager → share đang suspended)" : "";
          lines.push(
            `• <@${share.granteeDiscordId}> · \`${share.accessLevel}\`${tag}`,
          );
        }
      }
    }

    if (showOutgoing && showIncoming) lines.push("");

    if (showIncoming) {
      lines.push("**📥 Incoming shares** (người khác share cho cậu):");
      if (incoming.length === 0) {
        lines.push("_Chưa ai share roster cho cậu._");
      } else {
        for (const share of incoming) {
          const ownerDoc = incomingOwnerById.get(share.ownerDiscordId);
          const label = ownerLabel(ownerDoc, share.ownerDiscordId);
          const suspended = !isManagerId(share.ownerDiscordId);
          const tag = suspended ? " ⚠️ (owner hết Manager → share đang suspended)" : "";
          lines.push(
            `• ${label} (<@${share.ownerDiscordId}>) · \`${share.accessLevel}\`${tag}`,
          );
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle("🔗 Roster Share · Overview")
      .setDescription(lines.join("\n"))
      .setFooter({
        text: "/raid-share grant target:@... · /raid-share revoke target:@...",
      });

    await interaction.editReply({ embeds: [embed] });
  }

  // Top-level dispatch. Permission gate (Manager-only) applies to
  // grant/revoke. List is open to everyone so a regular user can see
  // who has shared rosters with them.
  async function handleRaidShareCommand(interaction) {
    const sub = interaction.options.getSubcommand();

    if ((sub === "grant" || sub === "revoke") && !isManagerId(interaction.user.id)) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          EmbedBuilder,
          UI,
          type: "error",
          title: "Manager-only command",
          description:
            "`/raid-share grant` và `/raid-share revoke` chỉ dành cho Raid Manager " +
            "(env `RAID_MANAGER_ID`). Cậu vẫn có thể `/raid-share list` để xem ai đang share roster cho cậu.",
        })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "grant") return handleGrant(interaction);
    if (sub === "revoke") return handleRevoke(interaction);
    if (sub === "list") return handleList(interaction);

    await interaction.reply({
      content: `Unknown subcommand: ${sub}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  return { handleRaidShareCommand };
}

module.exports = { createRaidShareCommand };
