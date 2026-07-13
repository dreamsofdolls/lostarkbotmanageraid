"use strict";

const RaidEvent = require("../../../models/RaidEvent");
const {
  FILTER_ALL_RAIDS,
  FILTER_ALL_ROSTERS,
  FILTER_NO_ROSTERS,
} = require("../raid-filter");
const {
  STATUS_COMPONENT_ACTION,
} = require("./component-routes");
const {
  parseTaskToggleValue,
  toggleParsedSideTask,
} = require("../task/task-actions");
const {
  parseGoldModeValue,
  parseGoldToggleValue,
  setParsedGoldRaidMode,
  toggleParsedGoldRaid,
} = require("../gold/gold-actions");
const {
  createGoldReplacementFlow,
} = require("../gold/gold-replacement-flow");
const {
  localizedRaidLabel,
} = require("../gold/gold-formatting");
const {
  followUpNotice,
  replyNotice,
  replyEmbed,
} = require("../../../utils/raid/common/shared");
const {
  rotateLocalSyncToken,
  extractIdentityFromUser,
} = require("../../../services/local-sync");
const {
  publicBaseUrl,
  buildLocalSyncUrl,
} = require("../local-sync-controls");
const {
  buildManualSyncFollowupPayload,
} = require("../sync/sync-followup");
const {
  firstSelectValue,
} = require("../../../utils/discord/component-values");
const {
  t,
} = require("../../../services/i18n");

function noRedraw() {
  return { redraw: false };
}

function redraw() {
  return { redraw: true };
}

function buildRosterRefreshFollowupPayload(result, lang) {
  const accountName = result?.accountName || "?";
  if (result?.status === "updated") {
    return {
      type: "success",
      title: t("raid-status.sync.rosterRefreshSuccessTitle", lang),
      description: t("raid-status.sync.rosterRefreshSuccessDescription", lang, {
        accountName,
      }),
    };
  }

  if (result?.status === "attempted" || result?.status === "skipped") {
    return {
      type: "warn",
      title: t("raid-status.sync.rosterRefreshNoUpdateTitle", lang),
      description: t("raid-status.sync.rosterRefreshNoUpdateDescription", lang, {
        accountName,
      }),
    };
  }

  return {
    type: "warn",
    title: t("raid-status.sync.rosterRefreshMissingTitle", lang),
    description: t("raid-status.sync.rosterRefreshMissingDescription", lang, {
      accountName,
    }),
  };
}

function createStatusComponentRouteHandlers(ctx) {
  const {
    session,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    User,
    saveWithRetry,
    interaction,
    discordId,
    lang,
    buildStatusUserMeta,
    reloadViewerAccounts,
    buildEmbedAndCanvas,
    buildComponents,
    runManualStatusSync,
    runManualRosterRefresh,
    formatNextCooldownRemaining,
    formatGold,
    truncateText,
    getAutoManageCooldownMs,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
  } = ctx;
  const goldReplacementFlow = createGoldReplacementFlow({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    User,
    saveWithRetry,
    interaction,
    discordId,
    lang,
    reloadViewerAccounts,
    formatGold,
    truncateText,
  });

  return {
    [STATUS_COMPONENT_ACTION.prev]: async () => {
      session.movePage(-1);
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.next]: async () => {
      session.movePage(1);
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.localNewLink]: async (component) => {
      // Rotation edits the original message in-place because the visible
      // Resume button is the URL the user needs after the click.
      const deferred = await component.deferUpdate().then(() => true).catch((err) => {
        console.warn("[raid-status] local-new-link defer failed:", err?.message || err);
        return false;
      });
      if (!deferred) return noRedraw();

      const baseUrl = publicBaseUrl();
      if (!baseUrl) {
        await followUpNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.sync.localNewLinkUnavailableTitle", lang),
          description: t("raid-status.sync.localNewLinkUnavailableDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      let freshUrl;
      try {
        const identity = extractIdentityFromUser(component.user);
        const token = await rotateLocalSyncToken(discordId, lang, { UserModel: User, identity });
        freshUrl = buildLocalSyncUrl(token, baseUrl);
      } catch (err) {
        console.error("[raid-status] rotate local-sync token failed:", err?.message || err);
        await followUpNotice(component, EmbedBuilder, {
          type: "error",
          title: t("raid-status.sync.localNewLinkFailedTitle", lang),
          description: t("raid-status.sync.localNewLinkFailedDescription", lang, {
            error: err?.message || String(err),
          }),
        }).catch(() => {});
        return noRedraw();
      }

      session.setCachedLocalSyncResumeUrl(freshUrl);
      await interaction.editReply({
        ...(await buildEmbedAndCanvas()),
        components: buildComponents(false),
      }).catch((err) => {
        console.warn("[raid-status] local-new-link editReply failed:", err?.message || err);
      });

      await followUpNotice(component, EmbedBuilder, {
        type: "success",
        title: t("raid-status.sync.localNewLinkSuccessTitle", lang),
        description: t("raid-status.sync.localNewLinkSuccessDescription", lang),
      }).catch(() => {});
      return noRedraw();
    },

    [STATUS_COMPONENT_ACTION.localRefresh]: async (component) => {
      const deferred = await component.deferUpdate().then(() => true).catch((err) => {
        console.warn("[raid-status] local-refresh defer failed:", err?.message || err);
        return false;
      });
      if (!deferred) return noRedraw();

      try {
        await reloadViewerAccounts();
        session.statusUserMeta = buildStatusUserMeta(
          session.userDoc,
          session.statusUserMeta?.piggybackOutcome || null
        );
      } catch (err) {
        console.error("[raid-status] local-refresh reload failed:", err?.message || err);
      }

      await interaction.editReply({
        ...(await buildEmbedAndCanvas()),
        components: buildComponents(false),
      }).catch((err) => {
        console.warn("[raid-status] local-refresh editReply failed:", err?.message || err);
      });

      await followUpNotice(component, EmbedBuilder, {
        type: "success",
        title: t("raid-status.sync.localRefreshSuccessTitle", lang),
        description: t("raid-status.sync.localRefreshSuccessDescription", lang),
      }).catch(() => {});
      return noRedraw();
    },

    [STATUS_COMPONENT_ACTION.rosterRefresh]: async (component) => {
      const targetAccount = session.accounts[session.currentPage];
      const targetAccountName = targetAccount?.accountName || "";
      const sharedFrom = targetAccount?._sharedFrom;
      if (!targetAccountName) {
        await replyNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.sync.rosterRefreshMissingTitle", lang),
          description: t("raid-status.sync.rosterRefreshMissingDescription", lang, {
            accountName: "?",
          }),
        }).catch(() => {});
        return noRedraw();
      }
      if (sharedFrom && sharedFrom.accessLevel !== "edit") {
        await replyNotice(component, EmbedBuilder, {
          type: "lock",
          title: t("raid-status.sync.rosterRefreshSharedLockedTitle", lang),
          description: t("raid-status.sync.rosterRefreshSharedLockedDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }
      if (typeof runManualRosterRefresh !== "function") {
        await replyNotice(component, EmbedBuilder, {
          type: "error",
          title: t("raid-status.sync.rosterRefreshFailedTitle", lang),
          description: t("raid-status.sync.rosterRefreshFailedDescription", lang, {
            error: "manual refresh service unavailable",
          }),
        }).catch(() => {});
        return noRedraw();
      }

      const deferred = await component.deferUpdate().then(() => true).catch((err) => {
        console.warn("[raid-status] roster-refresh defer failed:", err?.message || err);
        return false;
      });
      if (!deferred) return noRedraw();

      const writeDiscordId = sharedFrom ? sharedFrom.ownerDiscordId : discordId;
      try {
        const result = await runManualRosterRefresh(writeDiscordId, targetAccountName);
        await reloadViewerAccounts(writeDiscordId === discordId ? result.userDoc : null);
        session.statusUserMeta = buildStatusUserMeta(
          session.userDoc,
          session.statusUserMeta?.piggybackOutcome || null
        );

        await interaction.editReply({
          ...(await buildEmbedAndCanvas()),
          components: buildComponents(false),
        }).catch((err) => {
          console.warn("[raid-status] roster-refresh editReply failed:", err?.message || err);
        });

        await followUpNotice(
          component,
          EmbedBuilder,
          buildRosterRefreshFollowupPayload(result, lang)
        ).catch(() => {});
      } catch (err) {
        console.error("[raid-status] roster-refresh failed:", err?.message || err);
        await followUpNotice(component, EmbedBuilder, {
          type: "error",
          title: t("raid-status.sync.rosterRefreshFailedTitle", lang),
          description: t("raid-status.sync.rosterRefreshFailedDescription", lang, {
            error: err?.message || String(err),
          }),
        }).catch(() => {});
      }
      return noRedraw();
    },

    [STATUS_COMPONENT_ACTION.sync]: async (component) => {
      if (!session.statusUserMeta.autoManageEnabled) {
        await replyNotice(component, EmbedBuilder, {
          type: "info",
          title: t("raid-status.sync.noAutoSyncTitle", lang),
          description: t("raid-status.sync.noAutoSyncDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      const manualResult = await runManualStatusSync(discordId, {
        onAcquired: () => component.deferUpdate().catch(() => {}),
      });
      const manualOutcome = manualResult.outcome;
      if (manualResult.status === "cooldown") {
        const cooldownMs =
          typeof getAutoManageCooldownMs === "function"
            ? getAutoManageCooldownMs(discordId)
            : AUTO_MANAGE_SYNC_COOLDOWN_MS;
        const remain =
          formatNextCooldownRemaining(
            Number(session.statusUserMeta.lastAutoManageAttemptAt) || 0,
            cooldownMs
          ) || t("raid-status.sync.cooldownFallback", lang);
        await replyNotice(component, EmbedBuilder, {
          type: "info",
          title: t("raid-status.sync.cooldownTitle", lang),
          description: t("raid-status.sync.cooldownDescription", lang, { remain }),
        }).catch(() => {});
        return noRedraw();
      }

      const reloaded = manualResult.userDoc;
      if (reloaded && Array.isArray(reloaded.accounts)) {
        await reloadViewerAccounts(reloaded);
        session.statusUserMeta = buildStatusUserMeta(session.userDoc, manualOutcome);
      } else {
        session.statusUserMeta = {
          ...session.statusUserMeta,
          piggybackOutcome: manualOutcome,
        };
      }

      await interaction.editReply({
        ...(await buildEmbedAndCanvas()),
        components: buildComponents(false),
      }).catch(() => {});

      const followupPayload = buildManualSyncFollowupPayload(manualOutcome, lang);
      if (followupPayload) await followUpNotice(component, EmbedBuilder, followupPayload).catch(() => {});
      return noRedraw();
    },

    [STATUS_COMPONENT_ACTION.myRaidsSelect]: async (component) => {
      const eventId = firstSelectValue(component);
      const ev = eventId ? await RaidEvent.findById(eventId).catch(() => null) : null;
      if (!ev) {
        await replyNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.myRaids.notFoundTitle", lang),
          description: t("raid-status.myRaids.notFoundDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }
      await replyEmbed(
        component,
        ctx.buildMyRaidDetailEmbed(ev, component.user.id, { EmbedBuilder, UI, lang }),
      ).catch(() => {});
      return noRedraw();
    },

    [STATUS_COMPONENT_ACTION.raidFilter]: async (component) => {
      const value = firstSelectValue(component, FILTER_ALL_RAIDS);
      session.filterRaidId = value === FILTER_ALL_RAIDS ? null : value;
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.rosterFilter]: async (component) => {
      const value = firstSelectValue(component, FILTER_ALL_ROSTERS);
      if (value === FILTER_NO_ROSTERS) return noRedraw();
      if (value === FILTER_ALL_ROSTERS) {
        session.selectRoster(null);
        return redraw();
      }
      const rosterIndex = Number(value);
      if (!Number.isInteger(rosterIndex)) return noRedraw();
      session.selectRoster(rosterIndex);
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.viewToggle]: async (component) => {
      const picked = firstSelectValue(component, "raid");
      session.currentView = picked === "task" || picked === "gold" ? picked : "raid";
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.taskCharFilter]: async (component) => {
      const picked = firstSelectValue(component, "");
      if (picked) {
        session.setTaskCharFilterForPage(session.currentPage, picked);
      }
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.taskToggle]: async (component) => {
      const value = firstSelectValue(component, "");
      const parsed = parseTaskToggleValue(value);
      if (parsed.kind === "noop" || parsed.kind === "invalid") {
        return noRedraw();
      }

      const targetAccount = session.accounts[session.currentPage];
      const targetAccountName = targetAccount?.accountName || "";
      if (!targetAccountName) {
        return noRedraw();
      }

      const sharedFrom = targetAccount?._sharedFrom;
      if (sharedFrom && sharedFrom.accessLevel !== "edit") {
        console.log(
          `[raid-status side-task toggle] view-only share rejected ` +
          `executor=${discordId} owner=${sharedFrom.ownerDiscordId} kind=${parsed.kind}`,
        );
        return noRedraw();
      }
      const writeDiscordId = sharedFrom ? sharedFrom.ownerDiscordId : discordId;
      if (sharedFrom) {
        console.log(
          `[raid-status side-task toggle] share-write executor=${discordId} ` +
          `owner=${writeDiscordId} kind=${parsed.kind}`,
        );
      }

      await toggleParsedSideTask({
        User,
        saveWithRetry,
        discordId: writeDiscordId,
        targetAccountName,
        parsed,
      });

      await reloadViewerAccounts();
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.goldCharFilter]: async (component) => {
      const picked = firstSelectValue(component, "");
      if (picked) {
        session.setGoldCharFilterForPage(session.currentPage, picked);
      }
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.goldReplace]: async (component) => {
      return goldReplacementFlow.complete(component);
    },

    [STATUS_COMPONENT_ACTION.goldMode]: async (component) => {
      const value = firstSelectValue(component, "");
      const parsed = parseGoldModeValue(value);
      if (parsed.kind === "noop" || parsed.kind === "invalid") {
        return noRedraw();
      }

      const targetAccount = session.accounts[session.currentPage];
      const targetAccountName = targetAccount?.accountName || "";
      if (!targetAccountName) {
        return noRedraw();
      }

      const sharedFrom = targetAccount?._sharedFrom;
      if (sharedFrom && sharedFrom.accessLevel !== "edit") {
        console.log(
          `[raid-status gold mode] view-only share rejected ` +
          `executor=${discordId} owner=${sharedFrom.ownerDiscordId} raid=${parsed.raidKey}`,
        );
        return noRedraw();
      }
      const writeDiscordId = sharedFrom ? sharedFrom.ownerDiscordId : discordId;
      if (sharedFrom) {
        console.log(
          `[raid-status gold mode] share-write executor=${discordId} ` +
          `owner=${writeDiscordId} raid=${parsed.raidKey}`,
        );
      }

      let result;
      try {
        result = await setParsedGoldRaidMode({
          User,
          saveWithRetry,
          discordId: writeDiscordId,
          targetAccountName,
          targetCharName: parsed.targetCharName,
          raidKey: parsed.raidKey,
          modeKey: parsed.modeKey,
        });
      } catch (err) {
        console.warn("[raid-status gold mode] save failed:", err?.message || err);
        await followUpNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.goldView.modeFailedTitle", lang),
          description: t("raid-status.goldView.modeFailedDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      if (result.outcome === "ineligible") {
        await followUpNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.goldView.modeIneligibleTitle", lang),
          description: t("raid-status.goldView.modeIneligibleDescription", lang, {
            mode: result.modeLabel,
            raidLabel: result.raidLabel,
          }),
        }).catch(() => {});
        return noRedraw();
      }
      if (result.outcome === "noop") return noRedraw();
      if (!result.ok) {
        await followUpNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.goldView.modeFailedTitle", lang),
          description: t("raid-status.goldView.modeFailedDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      await reloadViewerAccounts(writeDiscordId === discordId ? result.userDoc : null);
      if (typeof component.followUp === "function") {
        const noticeKey = result.outcome === "immediate"
          ? "modeApplied"
          : result.outcome === "cancelled"
            ? "modeCancelled"
            : "modeDeferred";
        await followUpNotice(component, EmbedBuilder, {
          type: "success",
          title: t(`raid-status.goldView.${noticeKey}Title`, lang),
          description: t(`raid-status.goldView.${noticeKey}Description`, lang, {
            characterName: parsed.targetCharName,
            raidLabel: result.raidLabel,
            mode: result.modeLabel,
          }),
        }).catch(() => {});
      }
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.goldToggle]: async (component) => {
      const value = firstSelectValue(component, "");
      const parsed = parseGoldToggleValue(value);
      if (parsed.kind === "noop" || parsed.kind === "invalid") {
        return noRedraw();
      }

      const targetAccount = session.accounts[session.currentPage];
      const targetAccountName = targetAccount?.accountName || "";
      if (!targetAccountName) {
        return noRedraw();
      }

      const sharedFrom = targetAccount?._sharedFrom;
      if (sharedFrom && sharedFrom.accessLevel !== "edit") {
        console.log(
          `[raid-status gold toggle] view-only share rejected ` +
          `executor=${discordId} owner=${sharedFrom.ownerDiscordId} raid=${parsed.raidKey}`,
        );
        return noRedraw();
      }
      const writeDiscordId = sharedFrom ? sharedFrom.ownerDiscordId : discordId;
      if (sharedFrom) {
        console.log(
          `[raid-status gold toggle] share-write executor=${discordId} ` +
          `owner=${writeDiscordId} raid=${parsed.raidKey}`,
        );
      }

      const toggleResult = await toggleParsedGoldRaid({
        User,
        saveWithRetry,
        discordId: writeDiscordId,
        targetAccountName,
        parsed,
      });
      if (toggleResult.needsReplacement) {
        return goldReplacementFlow.prompt({
          component,
          replacement: toggleResult.replacement,
          writeDiscordId,
          targetAccountName,
        });
      }
      if (!toggleResult.ok) {
        await followUpNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.goldView.toggleFailedTitle", lang),
          description: t("raid-status.goldView.toggleFailedDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      await reloadViewerAccounts();
      if (toggleResult.override === "include" && typeof component.followUp === "function") {
        await followUpNotice(component, EmbedBuilder, {
          type: "success",
          title: t("raid-status.goldView.toggleSuccessTitle", lang),
          description: t("raid-status.goldView.toggleSuccessDescription", lang, {
            characterName: parsed.targetCharName,
            raidLabel: localizedRaidLabel(toggleResult.targetRaid, lang) || parsed.raidKey,
          }),
        }).catch(() => {});
      }
      return redraw();
    },
  };
}

module.exports = {
  createStatusComponentRouteHandlers,
};
