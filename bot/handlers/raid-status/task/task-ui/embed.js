"use strict";

function createTaskViewEmbedBuilder({
  EmbedBuilder,
  UI,
  truncateText,
  lang,
  getAccounts,
  getCurrentPage,
  addTaskViewContent,
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

    const footerParts = addTaskViewContent({
      embed,
      fields,
      totals,
      sharedTasks,
      now,
      lang,
      UI,
      getSharedTaskDisplay,
      truncateText,
      text: {
        sharedOverflow: (n) => t("raid-status.taskView.moreSharedTasks", lang, { n }),
        sharedHeader: () => t("raid-status.taskView.sharedTasksHeader", lang),
        characterOverflow: (n) => t("raid-status.taskView.moreCharacters", lang, { n }),
        sharedFooter: ({ done, total }) =>
          `${UI.icons.done} ${t("raid-status.taskView.footerSharedDone", lang, { done, total })}`,
        dailyFooter: ({ done, total }) =>
          `${UI.icons.done} ${t("raid-status.taskView.footerDailyDone", lang, { done, total })}`,
        weeklyFooter: ({ done, total }) =>
          `${UI.icons.done} ${t("raid-status.taskView.footerWeeklyDone", lang, { done, total })}`,
      },
    });
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
