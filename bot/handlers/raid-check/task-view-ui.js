const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const { buildAccountTaskFields } = require("../../utils/raid/tasks/task-view");
const {
  getVisibleSharedTasks,
  getSharedTaskDisplay,
} = require("../../utils/raid/tasks/shared-tasks");
const { t, getUserLanguage } = require("../../services/i18n");

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
    // Manager (clicker) is the viewer here - read-only spot-check.
    const lang = await getUserLanguage(interaction.user?.id, { UserModel: User });

    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-check.staleButton.title", lang),
            description: t("raid-check.staleButton.taskViewDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userDoc = await User.findOne({ discordId: targetDiscordId })
      .select(
        "discordId discordUsername discordGlobalName discordDisplayName accounts.accountName accounts.sharedTasks accounts.characters.name accounts.characters.class accounts.characters.itemLevel accounts.characters.sideTasks"
      )
      .lean();

    if (!userDoc) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-check.taskView.noUserTitle", lang),
            description: t("raid-check.taskView.noUserDescription", lang, { target: targetDiscordId }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
    const accountsWithTasks = accounts.filter((account) => {
      const chars = Array.isArray(account?.characters) ? account.characters : [];
      const hasSideTasks = chars.some(
        (c) => Array.isArray(c?.sideTasks) && c.sideTasks.length > 0
      );
      return hasSideTasks || getVisibleSharedTasks(account).length > 0;
    });

    if (accountsWithTasks.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-check.taskView.noTasksTitle", lang, { target: targetDiscordId }),
            description: [
              t("raid-check.taskView.noTasksLine1", lang, { target: targetDiscordId }),
              t("raid-check.taskView.noTasksLine2", lang),
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
      const accountName = String(
        account.accountName || t("raid-check.taskView.unnamedRoster", lang)
      );
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`📝 ${displayName} · ${accountName}`);
      const { fields, totals } = buildAccountTaskFields(account, {
        UI,
        getClassEmoji: () => "",
        truncateText,
        lang,
      });
      const now = new Date();
      const sharedTasks = getVisibleSharedTasks(account, now.getTime());
      if (sharedTasks.length > 0) {
        const lines = sharedTasks.slice(0, 12).map((task) => {
          const display = getSharedTaskDisplay(task, now, lang);
          const icon = display.completed ? UI.icons.done : UI.icons.pending;
          return `${icon} ${display.emoji} **${display.name}** · ${display.status}`;
        });
        if (sharedTasks.length > 12) {
          lines.push(t("raid-check.taskView.sharedTaskExtra", lang, { n: sharedTasks.length - 12 }));
        }
        embed.addFields({
          name: t("raid-check.taskView.sharedTaskHeader", lang),
          value: truncateText(lines.join("\n"), 1024),
          inline: false,
        });
      }
      const fieldBudget = sharedTasks.length > 0 ? 24 : 25;
      const visibleFields =
        fields.length > fieldBudget
          ? [
              ...fields.slice(0, fieldBudget - 1),
              {
                name: "…",
                value: t("raid-check.taskView.charsExtraField", lang, { n: fields.length - fieldBudget + 1 }),
                inline: false,
              },
            ]
          : fields;
      if (visibleFields.length > 0) embed.addFields(...visibleFields);
      const footerParts = [];
      if (sharedTasks.length > 0) {
        const sharedDone = sharedTasks.filter((task) =>
          getSharedTaskDisplay(task, now, lang).completed
        ).length;
        footerParts.push(t("raid-check.taskView.sharedFooter", lang, {
          doneIcon: UI.icons.done,
          done: sharedDone,
          total: sharedTasks.length,
        }));
      }
      if (totals.daily > 0) {
        footerParts.push(t("raid-check.taskView.dailyFooter", lang, {
          doneIcon: UI.icons.done,
          done: totals.dailyDone,
          total: totals.daily,
        }));
      }
      if (totals.weekly > 0) {
        footerParts.push(t("raid-check.taskView.weeklyFooter", lang, {
          doneIcon: UI.icons.done,
          done: totals.weeklyDone,
          total: totals.weekly,
        }));
      }
      if (totalPages > 1) {
        footerParts.push(t("raid-check.taskView.pageFooter", lang, {
          current: pageIdx + 1,
          total: totalPages,
        }));
      }
      footerParts.push(t("raid-check.taskView.readOnlySuffix", lang));
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
