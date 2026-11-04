"use strict";

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
  GOLD_RECEIVE_AUTO,
  parseGoldModeValues,
  parseGoldReceiveValues,
  saveBulkGoldReceive,
  saveBulkRaidModes,
} = require("../gold/gold-actions");
const { goldReceiveDefaults } = require("../gold/gold-ui/toggle-rows");
const {
  buildGoldReceiveSummaryNotice,
  buildModeSummaryNotice,
} = require("../gold/gold-summary");
const { getClassEmoji: defaultGetClassEmoji } = require("../../../models/Class");
const { createStatusRedraw } = require("../view/redraw");
const {
  deferEphemeralReply,
  editEmbed,
  editNotice,
  followUpNotice,
  replyNotice,
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
  selectValues,
} = require("../../../utils/discord/component-values");
const {
  t,
} = require("../../../services/i18n");
const { buildRosterRefreshNotice } = require("../../../services/roster/refresh-outcome");
const {
  canEditAccount,
  getAccessibleAccounts,
  isShareStillListed,
} = require("../../../services/access/access-control");

function noRedraw() {
  return { redraw: false };
}

function redraw() {
  return { redraw: true };
}

const ROSTER_REFRESH_NOTICES = Object.freeze({
  updated: {
    type: "success",
    title: "raid-status.sync.rosterRefreshSuccessTitle",
    description: "raid-status.sync.rosterRefreshSuccessDescription",
  },
  noUpdate: {
    type: "warn",
    title: "raid-status.sync.rosterRefreshNoUpdateTitle",
    description: "raid-status.sync.rosterRefreshNoUpdateDescription",
  },
  missing: {
    type: "warn",
    title: "raid-status.sync.rosterRefreshMissingTitle",
    description: "raid-status.sync.rosterRefreshMissingDescription",
  },
});

// Notice keys per refused action. The view-only pair shows while the owner
// still shares a roster with the viewer; the revoked pair once nothing is shared.
const SHARE_REFUSAL_NOTICES = Object.freeze({
  task: {
    viewOnly: {
      title: "raid-task.shareViewOnly.title",
      description: "raid-task.shareViewOnly.description",
    },
    revoked: {
      title: "raid-task.shareRevoked.title",
      description: "raid-task.shareRevoked.description",
    },
  },
  gold: {
    viewOnly: {
      title: "raid-task.shareViewOnly.title",
      description: "raid-status.goldView.shareViewOnlyDescription",
    },
    revoked: {
      title: "raid-task.shareRevoked.title",
      description: "raid-status.goldView.shareRevokedDescription",
    },
  },
  rosterRefresh: {
    viewOnly: {
      title: "raid-status.sync.rosterRefreshSharedLockedTitle",
      description: "raid-status.sync.rosterRefreshSharedLockedDescription",
    },
    revoked: {
      title: "raid-status.sync.rosterRefreshShareRevokedTitle",
      description: "raid-status.sync.rosterRefreshShareRevokedDescription",
    },
  },
});

function buildRosterRefreshFollowupPayload(result, lang) {
  return buildRosterRefreshNotice(result, lang, ROSTER_REFRESH_NOTICES, {
    accountName: result?.accountName || "?",
  });
}

/**
 * Build the /raid-status component handlers, keyed by STATUS_COMPONENT_ACTION.
 * @param {object} ctx - session, builders, models and callbacks of one status
 *   session; canEditAccountFn and getAccessibleAccountsFn default to the
 *   access-control lookups and are injectable for tests; getGoldSelection
 *   returns the gold view's selected characters with their status raids
 * @returns {Object<string, Function>} handlers that resolve to { redraw }
 */
function createStatusComponentRouteHandlers(ctx) {
  const {
    session,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
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
    getAutoManageCooldownMs,
    isReplyPrivate,
    rotateLocalSyncTokenFn = rotateLocalSyncToken,
    canEditAccountFn = canEditAccount,
    getAccessibleAccountsFn = getAccessibleAccounts,
    refreshLocalSyncSnapshot = async () => null,
    runLocalSyncAction = async () => ({ ok: false, reason: "missing", job: null, applied: false }),
    getGoldSelection = () => [],
    getClassEmoji = defaultGetClassEmoji,
    // The session's shared redraw (view/redraw.js); built here when not given.
    redrawMessage = createStatusRedraw({
      interaction,
      buildEmbedAndCanvas,
      buildComponents,
      isSessionEnded: () => false,
    }),
  } = ctx;
  let latestViewTicket = 0;

  // _sharedFrom was read when /raid-status opened, and the owner can revoke
  // or downgrade the share while the card stays open, so writes to a shared
  // roster ask RosterShare again instead of trusting it.
  async function resolveCurrentAccountWriteContext({ logLabel, detail = "" }) {
    const targetAccount = session.accounts[session.currentPage];
    const targetAccountName = targetAccount?.accountName || "";
    if (!targetAccountName) return null;

    const sharedFrom = targetAccount?._sharedFrom;
    const detailSuffix = detail ? ` ${detail}` : "";
    if (sharedFrom && !(await canEditAccountFn(discordId, sharedFrom.ownerDiscordId))) {
      console.log(
        `[${logLabel}] share without edit rejected ` +
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
      // The writers ask again on every save attempt.
      canWrite: sharedFrom ? () => canEditAccountFn(discordId, sharedFrom.ownerDiscordId) : null,
    };
  }

  // A refused write only says the viewer cannot edit. The owner's shares to the
  // viewer tell a downgraded share, which is still listed, from a revoked one;
  // a failed lookup counts as downgraded.
  async function shareRefusalNotice(kind, sharedFrom) {
    const stillShared = await isShareStillListed(discordId, sharedFrom?.ownerDiscordId, {
      getAccessibleAccounts: getAccessibleAccountsFn,
    });
    const keys = SHARE_REFUSAL_NOTICES[kind][stillShared ? "viewOnly" : "revoked"];
    return {
      type: "lock",
      title: t(keys.title, lang),
      description: t(keys.description, lang, {
        owner: sharedFrom?.ownerLabel || "(unknown)",
      }),
    };
  }

  async function followUpShareRefusal(component, kind, sharedFrom) {
    await followUpNotice(component, EmbedBuilder, await shareRefusalNotice(kind, sharedFrom)).catch(() => {});
  }

  // A null write context is either a share the owner revoked or downgraded
  // since the card was drawn, or a card page with no roster; only the share
  // case has a reason to show.
  async function followUpGoldShareRefusal(component) {
    const sharedFrom = session.accounts[session.currentPage]?._sharedFrom;
    if (!sharedFrom) return;
    await followUpShareRefusal(component, "gold", sharedFrom);
  }

  function goldViewNotice(type, titleKey, descriptionKey) {
    return {
      type,
      title: t(`raid-status.goldView.${titleKey}`, lang),
      description: t(`raid-status.goldView.${descriptionKey}`, lang),
    };
  }

  async function followUpGoldNotice(component, notice) {
    if (notice) await followUpNotice(component, EmbedBuilder, notice).catch(() => {});
  }

  // A save, or a selected character gone from the fresh document, leaves the
  // session snapshot stale. The viewer's own saved document feeds the reload
  // directly; a shared roster is read again.
  async function reloadAfterGoldWrite(result, writeDiscordId, isMissing) {
    if (!result.ok && !result.results.some(isMissing)) return;
    await reloadViewerAccounts(result.ok && writeDiscordId === discordId ? result.userDoc : null);
  }

  // The bulk writers load the owner's document fresh, apply to every selected
  // character and save once. A view-only or revoked share gets the refusal
  // notice and no redraw; every other outcome redraws, which also clears the
  // dropdown's client-side ticks.
  async function runGoldBulkWrite(component, { logLabel, selection, write, onSaveError, summarize }) {
    const writeContext = await resolveCurrentAccountWriteContext({
      logLabel,
      detail: `chars=${selection.length}`,
    });
    if (!writeContext) {
      await followUpGoldShareRefusal(component);
      return noRedraw();
    }
    const { targetAccount, targetAccountName, writeDiscordId, canWrite } = writeContext;

    let result;
    try {
      result = await write({
        User,
        saveWithRetry,
        discordId: writeDiscordId,
        targetAccountName,
        canWrite,
        targetCharNames: selection.map((entry) => entry.name),
      });
    } catch (err) {
      console.warn(`[${logLabel}] save failed:`, err?.message || err);
      await followUpGoldNotice(component, onSaveError);
      return redraw();
    }
    if (result.denied) {
      await followUpShareRefusal(component, "gold", targetAccount._sharedFrom);
      return noRedraw();
    }
    const { isMissing, notice } = summarize(result);
    await reloadAfterGoldWrite(result, writeDiscordId, isMissing);
    await followUpGoldNotice(component, notice);
    return redraw();
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

      // A public reply must never carry the signed URL: Discord link
      // buttons are clickable by anyone in the channel, so the rotated
      // link is delivered through the ephemeral follow-up below instead.
      if (isReplyPrivate()) {
        session.setCachedLocalSyncResumeUrl(freshUrl);
        await redrawMessage().catch((err) => {
          console.warn("[raid-status] local-new-link editReply failed:", err?.message || err);
        });
      }

      await followUpNotice(component, EmbedBuilder, {
        type: "success",
        title: t("raid-status.sync.localNewLinkSuccessTitle", lang),
        description: isReplyPrivate()
          ? t("raid-status.sync.localNewLinkSuccessDescription", lang)
          : t("raid-status.sync.localNewLinkSuccessPublicDescription", lang, { url: freshUrl }),
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
        await redrawMessage();
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
      const deferred = await component.deferUpdate().then(() => true).catch((err) => {
        console.warn("[raid-status] roster-refresh defer failed:", err?.message || err);
        return false;
      });
      if (!deferred) return noRedraw();

      // Checked after the defer so the RosterShare read cannot use up
      // Discord's three-second reply window.
      if (sharedFrom && !(await canEditAccountFn(discordId, sharedFrom.ownerDiscordId))) {
        await followUpShareRefusal(component, "rosterRefresh", sharedFrom);
        return noRedraw();
      }

      const writeDiscordId = sharedFrom ? sharedFrom.ownerDiscordId : discordId;
      try {
        const result = await runManualRosterRefresh(writeDiscordId, targetAccountName, {
          canWrite: sharedFrom ? () => canEditAccountFn(discordId, sharedFrom.ownerDiscordId) : null,
        });
        if (result.status === "denied") {
          await followUpShareRefusal(component, "rosterRefresh", sharedFrom);
          return noRedraw();
        }
        await reloadViewerAccounts(writeDiscordId === discordId ? result.userDoc : null);
        session.statusUserMeta = buildStatusUserMeta(
          session.userDoc,
          session.statusUserMeta?.piggybackOutcome || null
        );

        await redrawMessage().catch((err) => {
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
        const cooldownMs = getAutoManageCooldownMs(discordId);
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

      await redrawMessage().catch(() => {});

      const followupPayload = buildManualSyncFollowupPayload(manualOutcome, lang);
      if (followupPayload) await followUpNotice(component, EmbedBuilder, followupPayload).catch(() => {});
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
      const ticket = ++latestViewTicket;
      const picked = firstSelectValue(component, "raid");
      if (picked === "sync") {
        // Both render paths are synchronous, so the console payload has
        // to be resolved here and parked on the session first.
        const snapshot = await refreshLocalSyncSnapshot();
        if (ticket !== latestViewTicket) return noRedraw();
        session.localSyncSnapshot = snapshot;
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
      // The session holds the filter so a later refresh of the same preview
      // does not lose it; the stateless surfaces read it back out of the
      // select value.
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

      const writeContext = await resolveCurrentAccountWriteContext({
        logLabel: "raid-status side-task toggle",
        detail: `kind=${parsed.kind}`,
      });
      if (!writeContext) {
        // Task rows render disabled on a view-only share, so a pick only
        // lands here from a card drawn before the share or roster changed.
        const sharedFrom = session.accounts[session.currentPage]?._sharedFrom;
        await followUpNotice(component, EmbedBuilder, sharedFrom
          ? await shareRefusalNotice("task", sharedFrom)
          : {
            type: "warn",
            title: t("raid-status.taskView.toggleFailedTitle", lang),
            description: t("raid-status.taskView.toggleFailedDescription", lang),
          }).catch(() => {});
        return noRedraw();
      }
      const { targetAccount, targetAccountName, writeDiscordId, canWrite } = writeContext;

      const toggleResult = await toggleParsedSideTask({
        User,
        saveWithRetry,
        discordId: writeDiscordId,
        targetAccountName,
        canWrite,
        parsed,
      });
      if (toggleResult.denied) {
        await followUpShareRefusal(component, "task", targetAccount._sharedFrom);
        return noRedraw();
      }
      if (!toggleResult.ok) {
        await followUpNotice(component, EmbedBuilder, {
          type: "warn",
          title: t("raid-status.taskView.toggleFailedTitle", lang),
          description: t("raid-status.taskView.toggleFailedDescription", lang),
        }).catch(() => {});
        return noRedraw();
      }

      await reloadViewerAccounts();
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.goldChars]: async (component) => {
      const picked = selectValues(component).filter(Boolean);
      if (picked.length > 0) {
        session.setGoldCharSelectionForPage(session.currentPage, picked);
      }
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.goldReceive]: async (component) => {
      const values = selectValues(component);
      const receive = parseGoldReceiveValues(values);
      const selection = getGoldSelection();
      if (receive.kind === "invalid" || selection.length === 0) return noRedraw();
      // Closing the dropdown on its pre-ticked set must not pin characters
      // that already receive those raids automatically.
      if (receive.kind !== GOLD_RECEIVE_AUTO
        && sameRaidKeySet(receive.raidKeys, goldReceiveDefaults(selection))) {
        return redraw();
      }

      const isMissing = (entry) => entry.status === "missing";
      return runGoldBulkWrite(component, {
        logLabel: "raid-status gold receive",
        selection,
        write: (target) => saveBulkGoldReceive({ ...target, receive }),
        onSaveError: goldViewNotice("warn", "bulkSaveFailedTitle", "bulkSaveFailedDescription"),
        summarize: (result) => ({
          isMissing,
          notice: buildGoldReceiveSummaryNotice({
            result,
            receive,
            ignoredTicks: receive.kind === GOLD_RECEIVE_AUTO
              && values.some((value) => value !== GOLD_RECEIVE_AUTO),
            lang,
            getClassEmoji,
          }) || (
            // Every selected character is gone (the roster was renamed or
            // removed since the card was drawn): nothing was written.
            result.results.length > 0 && result.results.every(isMissing)
              ? goldViewNotice("warn", "bulkSaveFailedTitle", "bulkSaveFailedDescription")
              : null
          ),
        }),
      });
    },

    [STATUS_COMPONENT_ACTION.goldMode]: async (component) => {
      const { decisions, collapsed, invalid } = parseGoldModeValues(selectValues(component));
      const selection = getGoldSelection();
      if (invalid || selection.length === 0) return noRedraw();

      return runGoldBulkWrite(component, {
        logLabel: "raid-status gold mode",
        selection,
        write: (target) => saveBulkRaidModes({ ...target, decisions }),
        onSaveError: goldViewNotice("warn", "modeFailedTitle", "modeFailedDescription"),
        summarize: (result) => ({
          isMissing: (entry) => entry.missing,
          notice: buildModeSummaryNotice({ result, collapsed, lang, getClassEmoji }),
        }),
      });
    },
  };
}

function sameRaidKeySet(left, right) {
  return left.length === right.length && left.every((raidKey) => right.includes(raidKey));
}

module.exports = {
  createStatusComponentRouteHandlers,
};
