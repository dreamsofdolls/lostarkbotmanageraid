"use strict";

function createTaskViewEmbedBuilder({
  EmbedBuilder,
  UI,
  truncateText,
  lang,
  getAccounts,
  getCurrentPage,
  buildAccountTaskFields,
  getClassEmoji,
  getVisibleSharedTasks,
  getSharedTaskDisplay,
  t,
}) {
  return function buildTaskViewEmbed(account) {
    const accountName = String(account?.accountName || "(unnamed roster)");
    const embed = new EmbedBuilder()
      .setColor(UI.colors.neutral)
      .setTitle(t("raid-status.taskView.embedTitle", lang, { accountName }));

    const now = new Date();
    const sharedTasks = getVisibleSharedTasks(account, now.getTime());
    const { fields, totals } = buildAccountTaskFields(account, {
      UI,
      getClassEmoji,
      truncateText,
      lang,
    });

    if (totals.charsWithTasks === 0 && sharedTasks.length === 0) {
      embed.setDescription(
        t("raid-status.taskView.emptyDescription", lang, {
          iconReset: UI.icons.reset,
        })
      );
      return embed;
    }

    embed.setDescription(
      t("raid-status.taskView.mainDescription", lang, {
        iconReset: UI.icons.reset,
      })
    );

    if (sharedTasks.length > 0) {
      const lines = sharedTasks.slice(0, 12).map((task) => {
        const display = getSharedTaskDisplay(task, now, lang);
        const icon = display.completed ? UI.icons.done : UI.icons.pending;
        return `${icon} ${display.emoji} **${display.name}** \u00B7 ${display.status}`;
      });
      if (sharedTasks.length > 12) {
        lines.push(
          t("raid-status.taskView.moreSharedTasks", lang, {
            n: sharedTasks.length - 12,
          })
        );
      }
      embed.addFields({
        name: t("raid-status.taskView.sharedTasksHeader", lang),
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
              name: "...",
              value: t("raid-status.taskView.moreCharacters", lang, {
                n: fields.length - fieldBudget + 1,
              }),
              inline: false,
            },
          ]
        : fields;
    if (visibleFields.length > 0) embed.addFields(...visibleFields);

    const footerParts = [];
    if (sharedTasks.length > 0) {
      const sharedDone = sharedTasks.filter(
        (task) => getSharedTaskDisplay(task, now, lang).completed
      ).length;
      footerParts.push(
        `${UI.icons.done} ${t("raid-status.taskView.footerSharedDone", lang, {
          done: sharedDone,
          total: sharedTasks.length,
        })}`
      );
    }
    if (totals.daily > 0) {
      footerParts.push(
        `${UI.icons.done} ${t("raid-status.taskView.footerDailyDone", lang, {
          done: totals.dailyDone,
          total: totals.daily,
        })}`
      );
    }
    if (totals.weekly > 0) {
      footerParts.push(
        `${UI.icons.done} ${t("raid-status.taskView.footerWeeklyDone", lang, {
          done: totals.weeklyDone,
          total: totals.weekly,
        })}`
      );
    }
    if (getAccounts().length > 1) {
      footerParts.push(
        t("raid-status.taskView.footerPage", lang, {
          current: getCurrentPage() + 1,
          total: getAccounts().length,
        })
      );
    }
    if (footerParts.length > 0) {
      embed.setFooter({ text: footerParts.join(" \u00B7 ") });
    }
    return embed;
  };
}

module.exports = { createTaskViewEmbedBuilder };
