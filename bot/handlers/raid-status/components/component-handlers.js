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
  deferEphemeralReply,
  editEmbed,
  editNotice,
  followUpNotice,
  replyNotice,
  replyEmbed,
} = require("../../../utils/raid/common/shared");
const {
  COMPANION_SCOPE,
  rotateLocalSyncToken,
  publicBaseUrl,
  issueLocalSyncAccessUrl,
} = require("../../../services/local-sync");
const {
  buildManualSyncFollowupPayload,
} = require("../sync/sync-followup");
const {
  parseLocalSyncViewCustomId,
} = require("../sync/local-sync-view");
const {
  firstSelectValue,
} = require("../../../utils/discord/component-values");
const {
  t,
  tPick,
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
      title: tPick("raid-status.sync.rosterRefreshSuccessTitle", lang),
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
    ButtonBuilder,
    ButtonStyle,
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
    rotateLocalSyncTokenFn = rotateLocalSyncToken,
    refreshLocalSyncSnapshot = async () => null,
    runLocalSyncAction = async () => ({ ok: false, reason: "missing", job: null, applied: false }),
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

  function resolveCurrentAccountWriteContext({ logLabel, detail = "" }) {
    const targetAccount = session.accounts[session.currentPage];
    const targetAccountName = targetAccount?.accountName || "";
    if (!targetAccountName) return null;

    const sharedFrom = targetAccount?._sharedFrom;
    const detailSuffix = detail ? ` ${detail}` : "";
    if (sharedFrom && sharedFrom.accessLevel !== "edit") {
      console.log(
        `[${logLabel}] view-only share rejected ` +
        `executor=${discordId} owner=${sharedFrom.ownerDiscordId}${detailSuffix}`,
      );
      return null;
    }

    const writeDiscordId = sharedFrom ? sharedFrom.ownerDiscordId : discordId;
    if (sharedFrom) {
      console.log(
        `[${logLabel}] share-write executor=${discordId} ` +
        `owner=${writeDiscordId}${detailSuffix}`,
      );
    }
    return {
      targetAccount,
      targetAccountName,
      writeDiscordId,
    };
  }

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
        freshUrl = await issueLocalSyncAccessUrl({
          discordId,
          lang,
          UserModel: User,
          discordUser: component.user,
          baseUrl,
          tokenProvider: rotateLocalSyncTokenFn,
        });
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

    [STATUS_COMPONENT_ACTION.soloCompanion]: async (component) => {
      const deferred = await deferEphemeralReply(component).then(() => true).catch((err) => {
        console.warn("[raid-status] solo-companion defer failed:", err?.message || err);
        return false;
      });
      if (!deferred) return noRedraw();

      const baseUrl = publicBaseUrl();
      if (!baseUrl) {
        await editNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.sync.soloCompanionUnavailableTitle", lang),
          description: t("raid-status.sync.soloCompanionUnavailableDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      try {
        const companionUrl = await issueLocalSyncAccessUrl({
          discordId,
          lang,
          UserModel: User,
          discordUser: component.user,
          baseUrl,
          scope: COMPANION_SCOPE.solo,
          tokenProvider: rotateLocalSyncTokenFn,
        });
        if (!companionUrl) throw new Error("solo companion URL unavailable");

        const embed = new EmbedBuilder()
          .setColor(UI.colors.neutral)
          .setTitle(`${UI.icons.info} ${t("raid-status.sync.soloCompanionTitle", lang)}`)
          .setDescription(t("raid-status.sync.soloCompanionDescription", lang))
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(t("raid-status.sync.soloCompanionOpenButtonLabel", lang))
            .setEmoji("\u{1f310}")
            .setURL(companionUrl)
        );

        await editEmbed(component, embed, { components: [row] });
      } catch (err) {
        console.error("[raid-status] solo-companion link failed:", err?.message || err);
        await editNotice(component, EmbedBuilder, {
          type: "error",
          title: t("raid-status.sync.soloCompanionFailedTitle", lang),
          description: t("raid-status.sync.soloCompanionFailedDescription", lang, {
            error: err?.message || String(err),
          }),
        }).catch(() => {});
      }
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
        await interaction.editReply({
          ...(await buildEmbedAndCanvas()),
          components: buildComponents(false),
        });
      } catch (err) {
        console.error("[raid-status] local-refresh failed:", err?.message || err);
        await followUpNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.sync.localRefreshFailedTitle", lang),
          description: t("raid-status.sync.localRefreshFailedDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      await followUpNotice(component, EmbedBuilder, {
        type: "success",
        title: tPick("raid-status.sync.localRefreshSuccessTitle", lang),
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
      if (picked === "sync") {
        // Both render paths are synchronous, so the console payload has
        // to be resolved here and parked on the session first.
        session.localSyncSnapshot = await refreshLocalSyncSnapshot();
        session.currentView = "sync";
        return redraw();
      }
      session.currentView = picked === "task" || picked === "gold" ? picked : "raid";
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.localSyncAction]: async (component) => {
      const parsed = parseLocalSyncViewCustomId(component.customId);
      if (!parsed) return noRedraw();

      // Narrowing to one roster only changes what renders · no job work.
      // The session holds the filter so a later refresh does not lose it;
      // the stateless surfaces read it back out of the select value.
      if (parsed.action === "roster") {
        const value = firstSelectValue(component, FILTER_ALL_ROSTERS);
        if (value === FILTER_ALL_ROSTERS) {
          session.localSyncRosterFilter = null;
          return redraw();
        }
        const picked = Number(value);
        if (!Number.isFinite(picked)) return noRedraw();
        session.localSyncRosterFilter = picked;
        return redraw();
      }

      const result = await runLocalSyncAction(parsed);
      if (!result.ok) {
        if (result.reason === "notOwner") {
          await followUpNotice(component, EmbedBuilder, {
            type: "lock",
            title: t("raid-status.sync.noControlTitle", lang),
            description: t("local-sync-discord.notOwner", lang),
          }).catch(() => {});
        }
        // A vanished job still redraws · refreshing pulls whatever
        // preview replaced it instead of stranding the stale card.
        session.localSyncSnapshot = await refreshLocalSyncSnapshot();
        return redraw();
      }

      // Applying writes raid progress, so the merged account list the
      // raid and gold views read from is stale until it is reloaded.
      if (result.applied) {
        await reloadViewerAccounts().catch((err) => {
          console.warn("[raid-status local-sync] reload after apply failed:", err?.message || err);
        });
      }
      session.localSyncSnapshot = await refreshLocalSyncSnapshot({
        jobId: result.job?.jobId || "",
      });
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

      const writeContext = resolveCurrentAccountWriteContext({
        logLabel: "raid-status side-task toggle",
        detail: `kind=${parsed.kind}`,
      });
      if (!writeContext) return noRedraw();
      const { targetAccountName, writeDiscordId } = writeContext;

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

      const writeContext = resolveCurrentAccountWriteContext({
        logLabel: "raid-status gold mode",
        detail: `raid=${parsed.raidKey}`,
      });
      if (!writeContext) return noRedraw();
      const { targetAccountName, writeDiscordId } = writeContext;

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

      const writeContext = resolveCurrentAccountWriteContext({
        logLabel: "raid-status gold toggle",
        detail: `raid=${parsed.raidKey}`,
      });
      if (!writeContext) return noRedraw();
      const { targetAccountName, writeDiscordId } = writeContext;

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
          title: tPick("raid-status.goldView.toggleSuccessTitle", lang),
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
