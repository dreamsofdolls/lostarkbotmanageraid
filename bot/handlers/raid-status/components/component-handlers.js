"use strict";

const RaidEvent = require("../../../models/RaidEvent");
const {
  FILTER_ALL_RAIDS,
} = require("../raid-filter");
const {
  STATUS_COMPONENT_ACTION,
} = require("./component-routes");
const {
  parseTaskToggleValue,
  toggleParsedSideTask,
} = require("../task/task-actions");
const {
  parseGoldToggleValue,
  replaceRaidGoldSelection,
  toggleParsedGoldRaid,
} = require("../gold/gold-actions");
const {
  followUpNotice,
  replyNotice,
  replyEmbed,
} = require("../../../utils/raid/common/shared");
const {
  rotateLocalSyncToken,
  extractProfileFromUser,
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
const { getRaidModeLabel } = require("../../../utils/raid/common/labels");

const GOLD_REPLACE_SELECT_ID = "status-gold:replace";
const EPHEMERAL_FLAG = 1 << 6;

function noRedraw() {
  return { redraw: false };
}

function redraw() {
  return { redraw: true };
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
    formatNextCooldownRemaining,
    formatGold,
    truncateText,
    getAutoManageCooldownMs,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
  } = ctx;

  function localizedRaidLabel(raid) {
    return getRaidModeLabel(raid?.raidKey, raid?.modeKey, lang) || raid?.raidName || raid?.raidKey || "";
  }

  function rawGoldTotal(raid) {
    return Number(raid?.rawTotalGold ?? raid?.totalGold) || 0;
  }

  function buildGoldReplacePrompt(replacement, selectId) {
    const targetRaid = localizedRaidLabel(replacement.targetRaid);
    const embed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(`${UI.icons.lock} ${t("raid-status.goldView.replaceRequiredTitle", lang, {
        cap: replacement.cap,
      })}`)
      .setDescription(t("raid-status.goldView.replaceRequiredDescription", lang, {
        cap: replacement.cap,
        characterName: replacement.targetCharName,
        targetRaid,
      }));

    const options = (replacement.options || []).slice(0, 25).map((raid) => {
      const icon = raid.goldBound ? UI.icons.lock : "\uD83D\uDCB0";
      const rank = Number(raid.goldSlotRank) || 0;
      const rankPrefix = rank > 0 ? `#${rank} ` : "";
      return {
        label: truncateText(`${icon} ${rankPrefix}${localizedRaidLabel(raid)}`, 100),
        description: truncateText(formatGold(rawGoldTotal(raid)), 100),
        value: raid.raidKey,
      };
    });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(selectId)
        .setPlaceholder(t("raid-status.goldView.replacePlaceholder", lang))
        .addOptions(options.length > 0 ? options : [{ label: "(empty)", value: "noop" }])
        .setDisabled(options.length === 0)
    );

    return { embed, row, targetRaid };
  }

  function makeGoldReplaceSelectId() {
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `${GOLD_REPLACE_SELECT_ID}:${token}`;
  }

  function buildGoldNoticeEmbed(type, title, description) {
    const color = type === "success"
      ? UI.colors.success
      : type === "warn"
        ? UI.colors.progress
        : UI.colors.neutral;
    const icon = type === "success"
      ? UI.icons.done
      : type === "warn"
        ? UI.icons.warn
        : UI.icons.info;
    return new EmbedBuilder()
      .setColor(color)
      .setTitle(`${icon} ${title}`)
      .setDescription(description);
  }

  function awaitGoldReplacementSelection({ component, prompt, selectId }) {
    const userId = component?.user?.id;
    const client = component?.client;
    if (client && typeof client.on === "function" && typeof client.off === "function") {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          client.off("interactionCreate", onInteraction);
        };
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(value);
        };
        const onInteraction = (select) => {
          if (select?.customId !== selectId) return;
          if (userId && select?.user?.id !== userId) return;
          finish(resolve, select);
        };
        timer = setTimeout(() => finish(reject, new Error("timeout")), 45_000);
        client.on("interactionCreate", onInteraction);
      });
    }

    return prompt.awaitMessageComponent({
      time: 45_000,
      filter: (select) =>
        select?.customId === selectId &&
        select?.user?.id === userId,
    });
  }

  async function acknowledgeGoldReplacement(select) {
    if (typeof select?.deferUpdate !== "function") return false;
    return select.deferUpdate().then(() => true).catch((err) => {
      console.warn("[raid-status gold replace] defer failed:", err?.message || err);
      return false;
    });
  }

  async function editGoldReplacementPrompt(select, prompt, payload, wasDeferred) {
    if (wasDeferred && typeof select?.editReply === "function") {
      const edited = await select.editReply(payload).then(() => true).catch((err) => {
        console.warn("[raid-status gold replace] editReply failed:", err?.message || err);
        return false;
      });
      if (edited) return true;
    }
    if (!wasDeferred && typeof select?.update === "function") {
      const updated = await select.update(payload).then(() => true).catch((err) => {
        console.warn("[raid-status gold replace] update failed:", err?.message || err);
        return false;
      });
      if (updated) return true;
    }
    if (prompt && typeof prompt.edit === "function") {
      return prompt.edit(payload).then(() => true).catch((err) => {
        console.warn("[raid-status gold replace] prompt edit failed:", err?.message || err);
        return false;
      });
    }
    return false;
  }

  async function promptGoldReplacement({
    component,
    replacement,
    writeDiscordId,
    targetAccountName,
  }) {
    const selectId = makeGoldReplaceSelectId();
    const { embed, row, targetRaid } = buildGoldReplacePrompt(replacement, selectId);
    const prompt = await component.followUp({
      embeds: [embed],
      components: [row],
      flags: EPHEMERAL_FLAG,
    }).catch((err) => {
      console.warn("[raid-status gold replace] prompt failed:", err?.message || err);
      return null;
    });

    const canAwaitPrompt = typeof prompt?.awaitMessageComponent === "function";
    const canAwaitClient = !!(
      component?.client &&
      typeof component.client.on === "function" &&
      typeof component.client.off === "function"
    );
    if (!prompt || (!canAwaitPrompt && !canAwaitClient)) {
      return noRedraw();
    }

    let picked;
    try {
      picked = await awaitGoldReplacementSelection({ component, prompt, selectId });
    } catch {
      await prompt.edit({
        embeds: [buildGoldNoticeEmbed(
          "warn",
          t("raid-status.goldView.replaceTimeoutTitle", lang),
          t("raid-status.goldView.replaceTimeoutDescription", lang, { targetRaid }),
        )],
        components: [],
      }).catch(() => {});
      return noRedraw();
    }

    const removedRaidKey = firstSelectValue(picked, "");
    const wasDeferred = await acknowledgeGoldReplacement(picked);
    if (!removedRaidKey || removedRaidKey === "noop") return noRedraw();

    const removedRaid = (replacement.options || []).find((raid) => raid.raidKey === removedRaidKey);
    let replaceResult;
    try {
      replaceResult = await replaceRaidGoldSelection({
        User,
        saveWithRetry,
        discordId: writeDiscordId,
        targetAccountName,
        targetCharName: replacement.targetCharName,
        includeRaidKey: replacement.targetRaid.raidKey,
        excludeRaidKey: removedRaidKey,
      });
    } catch (err) {
      console.warn("[raid-status gold replace] save failed:", err?.message || err);
      replaceResult = { ok: false };
    }

    if (!replaceResult.ok) {
      await editGoldReplacementPrompt(picked, prompt, {
        embeds: [buildGoldNoticeEmbed(
          "warn",
          t("raid-status.goldView.toggleFailedTitle", lang),
          t("raid-status.goldView.toggleFailedDescription", lang),
        )],
        components: [],
      }, wasDeferred);
      return noRedraw();
    }

    await reloadViewerAccounts();
    await editGoldReplacementPrompt(picked, prompt, {
      embeds: [buildGoldNoticeEmbed(
        "success",
        t("raid-status.goldView.replaceSuccessTitle", lang),
        t("raid-status.goldView.replaceSuccessDescription", lang, {
          characterName: replacement.targetCharName,
          targetRaid,
          removedRaid: localizedRaidLabel(removedRaid),
        }),
      )],
      components: [],
    }, wasDeferred);
    return redraw();
  }

  return {
    [STATUS_COMPONENT_ACTION.prev]: async () => {
      session.currentPage = Math.max(0, session.currentPage - 1);
      return redraw();
    },

    [STATUS_COMPONENT_ACTION.next]: async () => {
      session.currentPage = Math.min(session.accounts.length - 1, session.currentPage + 1);
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
        const profile = extractProfileFromUser(component.user);
        const token = await rotateLocalSyncToken(discordId, lang, { UserModel: User, profile });
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
        return promptGoldReplacement({
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
            raidLabel: localizedRaidLabel(toggleResult.targetRaid) || parsed.raidKey,
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
