"use strict";

const { t, getUserLanguage } = require("../../../services/i18n");
const { replyNotice } = require("../../../utils/raid/common/shared");
const {
  getNextSharedTaskTransitionMs,
} = require("../../../utils/raid/tasks/shared-tasks");
const { MY_RAIDS_SELECT_ID } = require("../my-raids");
const { getStatusComponentRoute } = require("./component-routes");

function attachRaidStatusComponentCollector({
  EmbedBuilder,
  User,
  interaction,
  message,
  lang,
  sessionMs,
  taskAutoRefreshGraceMs,
  getAccounts,
  getCurrentPage,
  getCurrentView,
  buildCurrentEmbed,
  buildEmbedAndCanvas,
  buildComponents,
  componentRouteHandlers,
}) {
  const collector = message.createMessageComponentCollector({ time: sessionMs });
  const sessionExpiresAtMs = Date.now() + sessionMs;
  let collectorEnded = false;
  let taskAutoRefreshTimer = null;

  const clearTaskAutoRefresh = () => {
    if (taskAutoRefreshTimer) {
      clearTimeout(taskAutoRefreshTimer);
      taskAutoRefreshTimer = null;
    }
  };

  const scheduleTaskAutoRefresh = () => {
    clearTaskAutoRefresh();
    if (collectorEnded || getCurrentView() !== "task") return;

    const nextTransitionMs = getNextSharedTaskTransitionMs(
      getAccounts()[getCurrentPage()],
      new Date()
    );
    if (!nextTransitionMs) return;

    const fireAtMs = nextTransitionMs + taskAutoRefreshGraceMs;
    if (fireAtMs >= sessionExpiresAtMs) return;

    const delayMs = Math.max(taskAutoRefreshGraceMs, fireAtMs - Date.now());
    taskAutoRefreshTimer = setTimeout(async () => {
      taskAutoRefreshTimer = null;
      if (collectorEnded || getCurrentView() !== "task") return;
      try {
        await interaction.editReply({
          ...(await buildEmbedAndCanvas()),
          components: buildComponents(false),
        });
      } catch (err) {
        console.warn("[raid-status task auto-refresh] edit failed:", err?.message || err);
        return;
      }
      scheduleTaskAutoRefresh();
    }, delayMs);
  };

  collector.on("collect", async (component) => {
    if (component.user.id !== interaction.user.id) {
      const clickerLang = await getUserLanguage(component.user.id, {
        UserModel: User,
      });
      await replyNotice(component, EmbedBuilder, {
        type: "lock",
        title: t("raid-status.sync.noControlTitle", clickerLang),
        description: t("raid-status.sync.noControlDescription", clickerLang),
      }).catch(() => {});
      return;
    }

    const route = getStatusComponentRoute(component.customId || "", {
      myRaidsSelectId: MY_RAIDS_SELECT_ID,
    });
    if (!route) return;

    if (route.editDriven) {
      const deferred = await component.deferUpdate().then(() => true).catch((err) => {
        console.warn("[raid-status component] defer failed:", err?.message || err);
        return false;
      });
      if (!deferred) return;
    }

    const handler = componentRouteHandlers[route.action];
    if (!handler) return;

    const result = await handler(component);
    if (!route.redraw || result?.redraw === false) return;

    const updated = await interaction.editReply({
      ...(await buildEmbedAndCanvas()),
      components: buildComponents(false),
    }).then(() => true).catch((err) => {
      console.warn("[raid-status component] edit failed:", err?.message || err);
      return false;
    });
    if (updated) scheduleTaskAutoRefresh();
  });

  collector.on("end", async () => {
    collectorEnded = true;
    clearTaskAutoRefresh();
    try {
      const expiredFooter = t("raid-status.expiredFooter", lang, {
        seconds: sessionMs / 1000,
      });
      const expiredEmbed = EmbedBuilder.from(buildCurrentEmbed()).setFooter({
        text: expiredFooter,
      });
      await interaction.editReply({
        embeds: [expiredEmbed],
        components: buildComponents(true),
        attachments: [],
      });
    } catch {
      // Interaction token may have expired.
    }
  });

  return {
    collector,
    scheduleTaskAutoRefresh,
  };
}

module.exports = {
  attachRaidStatusComponentCollector,
};
