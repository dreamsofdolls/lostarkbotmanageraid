const { buildNoticeEmbed } = require("../../raid/shared");
const { buildAccountTaskFields } = require("../../raid/task-view");

function createTaskViewUi(deps) {
  const {
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    truncateText,
    buildPaginationRow,
    RAID_CHECK_PAGINATION_SESSION_MS,
  } = deps;

  // Read-only Task view click handler triggered by the
  // "📝 Xem tasks" button in /raid-check. Renders ONE embed
  // per account with pagination (Prev/Next) when the user has > 1
  // account-with-tasks - matches /raid-status Task view's compact 2-
  // column layout instead of stacking N embeds, which Trainee flagged
  // as clunky on the round-29 first cut.
  //
  // Read-only: no toggle dropdown (Manager doesn't modify member
  // data). Reply is ephemeral so the data never lands in the channel
  // transcript - members aren't notified when a Manager spot-checks.
  async function handleRaidCheckViewTasksClick(interaction, targetDiscordId) {
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Button đã hết hạn",
            description: "Discord đã rớt context của button này (chắc bot vừa restart). Refresh `/raid-check` rồi thử lại nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userDoc = await User.findOne({ discordId: targetDiscordId })
      .select(
        "discordId discordUsername discordGlobalName discordDisplayName accounts.accountName accounts.characters.name accounts.characters.class accounts.characters.itemLevel accounts.characters.sideTasks"
      )
      .lean();

    if (!userDoc) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy user",
            description: `Artist không thấy doc của <@${targetDiscordId}> trong DB. Có thể user chưa từng dùng bot.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
    const accountsWithTasks = accounts.filter((account) => {
      const chars = Array.isArray(account?.characters) ? account.characters : [];
      return chars.some(
        (c) => Array.isArray(c?.sideTasks) && c.sideTasks.length > 0
      );
    });

    if (accountsWithTasks.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: `📝 Tasks · <@${targetDiscordId}>`,
            description: [
              `User <@${targetDiscordId}> chưa đăng ký side task nào.`,
              "Họ chưa từng dùng `/raid-task add` để track chore daily/weekly.",
            ].join("\n"),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const displayName =
      userDoc.discordDisplayName ||
      userDoc.discordGlobalName ||
      userDoc.discordUsername ||
      `<@${targetDiscordId}>`;
    const totalPages = accountsWithTasks.length;

    // Body delegated to the shared helper so the Manager view renders
    // the same per-char layout that the user sees in /raid-status. This
    // surface owns the title (display name + roster), pagination footer,
    // and the "Read-only" suffix that signals the Manager can look but
    // not toggle.
    const buildAccountEmbed = (account, pageIdx) => {
      const accountName = String(account.accountName || "(unnamed roster)");
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`📝 ${displayName} · ${accountName}`);
      const { fields, totals } = buildAccountTaskFields(account, {
        UI,
        getClassEmoji: () => "",
        truncateText,
      });
      if (fields.length > 0) embed.addFields(...fields);
      const footerParts = [];
      if (totals.daily > 0) {
        footerParts.push(`${UI.icons.done} ${totals.dailyDone}/${totals.daily} daily`);
      }
      if (totals.weekly > 0) {
        footerParts.push(`${UI.icons.done} ${totals.weeklyDone}/${totals.weekly} weekly`);
      }
      if (totalPages > 1) {
        footerParts.push(`Page ${pageIdx + 1}/${totalPages}`);
      }
      footerParts.push("Read-only · Manager view");
      embed.setFooter({ text: footerParts.join(" · ") });
      return embed;
    };

    let currentPage = 0;
    const buildComponents = (disabled) => {
      if (totalPages <= 1) return [];
      return [
        buildPaginationRow(currentPage, totalPages, disabled, {
          prevId: "raid-check-tasks-page:prev",
          nextId: "raid-check-tasks-page:next",
        }),
      ];
    };

    await interaction.reply({
      embeds: [buildAccountEmbed(accountsWithTasks[0], 0)],
      components: buildComponents(false),
      flags: MessageFlags.Ephemeral,
    });

    if (totalPages <= 1) return;

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      time: RAID_CHECK_PAGINATION_SESSION_MS,
    });
    collector.on("collect", async (component) => {
      // Ephemeral message - only the original Manager can interact, so
      // no per-user gating. Bound the customId to our prefix to avoid
      // routing past stray clicks (defensive against shared message ids).
      const id = component.customId || "";
      if (id === "raid-check-tasks-page:prev") {
        currentPage = Math.max(0, currentPage - 1);
      } else if (id === "raid-check-tasks-page:next") {
        currentPage = Math.min(totalPages - 1, currentPage + 1);
      } else {
        return;
      }
      await component
        .update({
          embeds: [buildAccountEmbed(accountsWithTasks[currentPage], currentPage)],
          components: buildComponents(false),
        })
        .catch(() => {});
    });
    collector.on("end", async () => {
      try {
        await interaction.editReply({
          embeds: [buildAccountEmbed(accountsWithTasks[currentPage], currentPage)],
          components: buildComponents(true),
        });
      } catch {
        /* token may have expired */
      }
    });
  }

  return { handleRaidCheckViewTasksClick };
}

module.exports = { createTaskViewUi };
