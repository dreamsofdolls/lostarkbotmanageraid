"use strict";

const { buildNoticeEmbed } = require("../utils/raid/shared");
const { t, getUserLanguage } = require("../services/i18n");
const {
  setLocalSyncEnabled,
  setBibleAutoSyncEnabled,
  getSyncStatus,
  mintToken: mintLocalSyncToken,
  RESULT: SYNC_RESULT,
} = require("../services/local-sync");

function createRaidAutoManageCommand(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
    getAutoManageCooldownMs,
    weekResetStartMs,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    isPublicLogDisabledError,
    commitAutoManageOn,
    buildAutoManageSyncReportEmbed,
    buildAutoManageHiddenCharsWarningEmbed,
    stampAutoManageAttempt,
  } = deps;

  async function handleRaidAutoManageCommand(interaction) {
    const discordId = interaction.user.id;
    // Slash invoker is the only viewer of every ephemeral reply on this
    // command, so resolve once and thread through every notice + success
    // embed. DM emitters resolve their own (recipient's) lang separately
    // via commitAutoManageOn / buildAutoManage* helpers further down.
    const lang = await getUserLanguage(discordId, { UserModel: User });
    const action = interaction.options.getString("action", true);
    // Autocomplete only offers the valid action set, but users can paste
    // arbitrary strings into slash command args. Reject early with a
    // specific hint - otherwise a typo falls through every branch and
    // Discord times out the interaction with no reply.
    const VALID_ACTIONS = ["on", "off", "sync", "status", "local-on", "local-off", "reset"];
    if (!VALID_ACTIONS.includes(action)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.invalid.actionTitle", lang),
            description: t("raid-auto-manage.invalid.actionDescription", lang, { action }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Redundant-state + local-mutex rejects for toggle/manual-sync actions
    // (autocomplete hides the redundant option, but users can paste the
    // full value). Single lean read gates all branches with one query -
    // both flags are independent (mutex enforced at write time, not read).
    if (["on", "off", "sync", "local-on", "local-off"].includes(action)) {
      const stateUser = await User.findOne(
        { discordId },
        { autoManageEnabled: 1, localSyncEnabled: 1 }
      ).lean();
      const bibleOn = !!stateUser?.autoManageEnabled;
      const localOn = !!stateUser?.localSyncEnabled;
      if (action === "on" && bibleOn) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-auto-manage.redundant.alreadyOnTitle", lang),
              description: t("raid-auto-manage.redundant.alreadyOnDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "off" && !bibleOn) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-auto-manage.redundant.alreadyOffTitle", lang),
              description: t("raid-auto-manage.redundant.alreadyOffDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "local-on" && localOn) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-auto-manage.redundant.localAlreadyOnTitle", lang),
              description: t("raid-auto-manage.redundant.localAlreadyOnDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "local-off" && !localOn) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-auto-manage.redundant.localAlreadyOffTitle", lang),
              description: t("raid-auto-manage.redundant.localAlreadyOffDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Mutex pre-reject for the bible-enable path: if local-sync is on,
      // /raid-auto-manage action:on must reject before the probe HTTPs.
      // Otherwise a successful probe + flag flip would leave both modes
      // active until the next save (the probeDoc.save() at line 189 only
      // sets autoManageEnabled, doesn't touch localSyncEnabled). Cheaper
      // to reject up front than to undo mid-flow.
      if (action === "on" && localOn) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-auto-manage.mutex.bibleBlockedByLocalTitle", lang),
              description: t("raid-auto-manage.mutex.bibleBlockedByLocalDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "sync" && localOn) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-auto-manage.sync.localLockedTitle", lang),
              description: t("raid-auto-manage.sync.localLockedDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    if (action === "off") {
      await User.findOneAndUpdate(
        { discordId },
        { $set: { autoManageEnabled: false } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      const embed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`${UI.icons.reset} ${t("raid-auto-manage.disable.title", lang)}`)
        .setDescription(t("raid-auto-manage.disable.description", lang))
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "local-on") {
      // Local-sync opt-in. Goes through the mutex helper so a concurrent
      // bible-enable on a different surface can't leave both flags on.
      // Strict (non-force) mode: surfaces a "tắt bible trước" embed when
      // the user already has bible auto-sync on, instead of silently
      // overwriting. The stuck-private-log "Switch to Local Sync" button
      // (Phase 6) uses force=true for one-click upgrade.
      const result = await setLocalSyncEnabled(
        discordId,
        true,
        { force: false },
        { UserModel: User }
      );
      if (!result.ok && result.reason === SYNC_RESULT.conflict) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-auto-manage.mutex.localBlockedByBibleTitle", lang),
              description: t("raid-auto-manage.mutex.localBlockedByBibleDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Success path. Mint a 30-min HMAC token and build the personalized
      // companion URL. Token mint can throw if LOCAL_SYNC_TOKEN_SECRET is
      // unset or PUBLIC_BASE_URL is missing - in those cases we degrade
      // gracefully: still show the success embed (the flag is already
      // flipped) but warn the user the companion link isn't available
      // yet. Operator should set both env vars + redeploy.
      const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      let companionUrl = null;
      let mintError = null;
      if (baseUrl) {
        try {
          // Embed user's lang in the token so the web companion renders
          // in their preferred language without an extra round-trip.
          // `lang` was resolved at handler entry via getUserLanguage.
          const token = mintLocalSyncToken(discordId, undefined, lang);
          companionUrl = `${baseUrl}/sync?token=${encodeURIComponent(token)}`;
        } catch (err) {
          mintError = err?.message || String(err);
          console.warn("[raid-auto-manage] local-on token mint failed:", mintError);
        }
      }
      const embed = new EmbedBuilder()
        .setColor(UI.colors.success)
        .setTitle(`${UI.icons.done} ${t("raid-auto-manage.localEnable.successTitle", lang)}`)
        .setDescription(
          companionUrl
            ? t("raid-auto-manage.localEnable.successDescriptionWithLink", lang)
            : t("raid-auto-manage.localEnable.successDescription", lang)
        )
        .setTimestamp();
      const replyPayload = { embeds: [embed], flags: MessageFlags.Ephemeral };
      if (companionUrl) {
        // Link button (URL style) - opens the companion in the user's
        // browser without firing a Discord interaction we'd have to
        // handle. Token rides as a query param; the page parses + caches
        // it for the eventual POST.
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(t("raid-auto-manage.localEnable.openButtonLabel", lang))
            .setURL(companionUrl)
        );
        replyPayload.components = [row];
      }
      await interaction.reply(replyPayload);
      return;
    }
    if (action === "local-off") {
      // Mirror of action:off but for the local-sync flag. No mutex concern
      // (turning OFF can never produce a both-on state). Helper clears
      // both localSyncEnabled and localSyncLinkedAt so a future opt-in
      // re-stamps the linkedAt timestamp fresh.
      const result = await setLocalSyncEnabled(
        discordId,
        false,
        {},
        { UserModel: User }
      );
      if (!result.ok && result.reason === SYNC_RESULT.noUser) {
        // Defensive: would mean a user invoked the command with no User
        // doc at all. Not realistic given the redundant-check read above
        // would have created one, but guard anyway.
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-auto-manage.redundant.localAlreadyOffTitle", lang),
              description: t("raid-auto-manage.redundant.localAlreadyOffDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`${UI.icons.reset} ${t("raid-auto-manage.localDisable.title", lang)}`)
        .setDescription(t("raid-auto-manage.localDisable.description", lang))
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "reset") {
      // Hard-reset: wipes the user's sync state + raid progress so the
      // next /raid-auto-manage on / local-on starts a fresh replay
      // from bible logs / encounters.db. Semantic ~ weekly maintenance
      // reset but for the SINGLE invoker only - never touches other
      // users' docs (single-user scope by discordId).
      //
      // Wipe scope (only fields tied to sync + raid clears):
      //   - autoManageEnabled / localSyncEnabled + linkedAt + tokens
      //   - lastAutoManage{Sync,Attempt}At, lastLocalSyncAt
      //   - lastPrivateLogNudgeAt (reset 7-day nudge dedup)
      //   - account.lastRefreshed{At,AttemptAt}
      //   - char.assignedRaids -> empty per-raid groups
      //   - char.publicLogDisabled -> false (re-probe next sync)
      //   - char.bibleSerial/Cid/Rid -> null (re-resolve next sync)
      //
      // Preserved: roster + char identity + side/shared tasks +
      // gold-earner flag + language + registeredBy. Mongo write happens
      // inside saveWithRetry so a concurrent VersionError retries
      // cleanly. Two-step confirm gates the destructive write.
      const warnEmbed = new EmbedBuilder()
        .setColor(UI.colors.error || 0xff5555)
        .setTitle(`${UI.icons.warn} ${t("raid-auto-manage.reset.confirmTitle", lang)}`)
        .setDescription(t("raid-auto-manage.reset.confirmDescription", lang))
        .setTimestamp();
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("auto-manage:reset-confirm")
          .setLabel(t("raid-auto-manage.reset.confirmButton", lang))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("auto-manage:reset-cancel")
          .setLabel(t("raid-auto-manage.reset.cancelButton", lang))
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        embeds: [warnEmbed],
        components: [confirmRow],
        flags: MessageFlags.Ephemeral,
      });
      const replyMsg = await interaction.fetchReply();
      let decision = null;
      try {
        const btn = await replyMsg.awaitMessageComponent({
          filter: (i) => i.user.id === discordId && i.customId.startsWith("auto-manage:reset-"),
          componentType: ComponentType.Button,
          time: 60_000,
        });
        decision = btn.customId === "auto-manage:reset-confirm" ? "confirm" : "cancel";
        await btn.deferUpdate().catch(() => {});
      } catch {
        decision = "timeout";
      }
      if (decision === "confirm") {
        try {
          await saveWithRetry(async () => {
            const userDoc = await User.findOne({ discordId });
            if (!userDoc) return;
            userDoc.autoManageEnabled = false;
            userDoc.localSyncEnabled = false;
            userDoc.localSyncLinkedAt = null;
            userDoc.lastAutoManageSyncAt = null;
            userDoc.lastAutoManageAttemptAt = null;
            userDoc.lastLocalSyncAt = null;
            userDoc.lastLocalSyncToken = null;
            userDoc.lastLocalSyncTokenExpAt = null;
            userDoc.lastPrivateLogNudgeAt = null;
            for (const account of userDoc.accounts || []) {
              account.lastRefreshedAt = null;
              account.lastRefreshAttemptAt = null;
              for (const character of account.characters || []) {
                // Reassigning the whole sub-doc is the simplest way to
                // wipe; Mongoose path-tracking picks it up without an
                // explicit markModified call because we replace the
                // top-level field reference.
                character.assignedRaids = { armoche: {}, kazeros: {}, serca: {} };
                character.publicLogDisabled = false;
                character.bibleSerial = null;
                character.bibleCid = null;
                character.bibleRid = null;
              }
            }
            await userDoc.save();
          });
        } catch (err) {
          console.error("[raid-auto-manage] reset failed:", err?.message || err);
          await interaction.editReply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "error",
                title: t("raid-auto-manage.reset.failTitle", lang),
                description: t("raid-auto-manage.reset.failDescription", lang, {
                  error: err?.message || String(err),
                }),
              }),
            ],
            components: [],
          }).catch(() => {});
          return;
        }
        const successEmbed = new EmbedBuilder()
          .setColor(UI.colors.success)
          .setTitle(`${UI.icons.done} ${t("raid-auto-manage.reset.successTitle", lang)}`)
          .setDescription(t("raid-auto-manage.reset.successDescription", lang))
          .setTimestamp();
        await interaction.editReply({ embeds: [successEmbed], components: [] }).catch(() => {});
      } else {
        const title = decision === "timeout"
          ? t("raid-auto-manage.reset.cancelTimeoutTitle", lang)
          : t("raid-auto-manage.reset.cancelTitle", lang);
        const cancelEmbed = new EmbedBuilder()
          .setColor(UI.colors.muted)
          .setTitle(`${UI.icons.reset} ${title}`)
          .setDescription(t("raid-auto-manage.reset.cancelDescription", lang))
          .setTimestamp();
        await interaction.editReply({ embeds: [cancelEmbed], components: [] }).catch(() => {});
      }
      return;
    }
    if (action === "on") {
      // Two-phase enable flow:
      //   Phase A (probe): fetch user, run sync in-memory WITHOUT saving.
      //     Tell us which chars return "403 / logs not enabled" before we
      //     flip anything.
      //   Phase B (commit): re-run sync on a fresh doc inside saveWithRetry
      //     and persist. Runs either immediately (no hidden chars) or after
      //     the user clicks "Vẫn bật" on the warning.
      //
      // If phase A finds any hidden-log chars → show a warning with confirm
      // / cancel buttons. 60s collector, invoker-scoped. Cancel or timeout →
      // flag stays OFF, nothing saved.
      //
      // Guard semantics for `on` (preserved from earlier rounds):
      //   - in-flight  → reject hard.
      //   - cooldown   → flip flag only, skip both probe and sync.
      const guard = await acquireAutoManageSyncSlot(discordId);
      if (!guard.acquired && guard.reason === "in-flight") {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-auto-manage.enable.inFlightTitle", lang),
              description: t("raid-auto-manage.enable.inFlightDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const cooldownSkip = !guard.acquired && guard.reason === "cooldown";
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        // --- Cooldown path: flip flag only, skip sync ---
        if (cooldownSkip) {
          await saveWithRetry(async () => {
            const userDoc = await User.findOne({ discordId });
            if (!userDoc) {
              await User.findOneAndUpdate(
                { discordId },
                { $set: { autoManageEnabled: true } },
                { upsert: true, setDefaultsOnInsert: true }
              );
              return;
            }
            userDoc.autoManageEnabled = true;
            await userDoc.save();
          });
          const embed = new EmbedBuilder()
            .setColor(UI.colors.success)
            .setTitle(`${UI.icons.done} ${t("raid-auto-manage.enable.cooldownSkipTitle", lang)}`)
            .setDescription(
              t("raid-auto-manage.enable.cooldownSkipDescription", lang, {
                remain: formatAutoManageCooldownRemaining(guard.remainingMs),
              })
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        // --- Phase A: probe (no save) ---
        const weekResetStart = weekResetStartMs();
        const probeDoc = await User.findOne({ discordId });
        // No user doc at all - flag flip only, show no-roster embed.
        if (!probeDoc) {
          await User.findOneAndUpdate(
            { discordId },
            { $set: { autoManageEnabled: true } },
            { upsert: true, setDefaultsOnInsert: true }
          );
          const embed = new EmbedBuilder()
            .setColor(UI.colors.success)
            .setTitle(`${UI.icons.done} ${t("raid-auto-manage.enable.successTitle", lang)}`)
            .setDescription(t("raid-auto-manage.enable.noRosterDescription", lang))
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        // Roster empty - flag flip only.
        if (!Array.isArray(probeDoc.accounts) || probeDoc.accounts.length === 0) {
          probeDoc.autoManageEnabled = true;
          await probeDoc.save();
          const embed = new EmbedBuilder()
            .setColor(UI.colors.success)
            .setTitle(`${UI.icons.done} ${t("raid-auto-manage.enable.successTitle", lang)}`)
            .setDescription(t("raid-auto-manage.enable.noRosterDescription", lang))
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        // Run gather + in-memory apply - DO NOT save probeDoc. Keep the
        // `collected` array so commit can reuse it without a second bible
        // run (previously probe + commit = 2× HTTP cost; now it's 1×).
        ensureFreshWeek(probeDoc);
        const probeCollected = await gatherAutoManageLogsForUserDoc(probeDoc, weekResetStart);
        const probeReport = applyAutoManageCollected(probeDoc, weekResetStart, probeCollected);
        const hiddenChars = (probeReport?.perChar || []).filter((c) =>
          isPublicLogDisabledError(c?.error)
        );
        // --- Direct commit path: no hidden chars found ---
        if (hiddenChars.length === 0) {
          const finalReport = await commitAutoManageOn(
            discordId,
            weekResetStart,
            probeCollected
          );
          const syncEmbed = buildAutoManageSyncReportEmbed(finalReport, lang);
          syncEmbed.setTitle(
            `${UI.icons.done} ${
              (finalReport?.appliedTotal || 0) > 0
                ? t("raid-auto-manage.enable.initialSyncCompleteTitle", lang)
                : t("raid-auto-manage.enable.initialSyncNothingTitle", lang)
            }`
          );
          await interaction.editReply({ embeds: [syncEmbed] });
          return;
        }
        // --- Warn + confirm path: hidden chars detected ---
        const warnEmbed = buildAutoManageHiddenCharsWarningEmbed(
          hiddenChars,
          probeReport,
          lang
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("auto-manage:confirm-on")
            .setLabel(t("raid-auto-manage.enable.confirmButton", lang))
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("auto-manage:cancel-on")
            .setLabel(t("raid-auto-manage.enable.cancelButton", lang))
            .setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({ embeds: [warnEmbed], components: [row] });
        const replyMsg = await interaction.fetchReply();
        let decision = null;
        try {
          const btn = await replyMsg.awaitMessageComponent({
            filter: (i) =>
              i.user.id === discordId && i.customId.startsWith("auto-manage:"),
            componentType: ComponentType.Button,
            time: 60_000,
          });
          decision = btn.customId === "auto-manage:confirm-on" ? "confirm" : "cancel";
          await btn.deferUpdate().catch(() => {});
        } catch {
          decision = "timeout";
        }
        if (decision === "confirm") {
          // Reuse probeCollected so confirm doesn't re-hit bible. Data is at
          // most 60s old (collector timeout ceiling) - acceptable staleness
          // for a one-shot initial sync; next /raid-auto-manage action:sync
          // will pull fresher data under the normal cooldown.
          const finalReport = await commitAutoManageOn(
            discordId,
            weekResetStart,
            probeCollected
          );
          const syncEmbed = buildAutoManageSyncReportEmbed(finalReport, lang);
          syncEmbed.setTitle(
            `${UI.icons.done} ${
              (finalReport?.appliedTotal || 0) > 0
                ? t("raid-auto-manage.enable.initialSyncCompleteTitle", lang)
                : t("raid-auto-manage.enable.initialSyncNothingTitle", lang)
            }`
          );
          await interaction.editReply({ embeds: [syncEmbed], components: [] });
        } else {
          // Probe HTTP already ran - stamp attempt so the cooldown reflects
          // the bible quota we consumed, even though we're not committing the
          // flag flip. Without this, spamming `action:on` + Cancel would bypass
          // the per-user sync cooldown.
          await stampAutoManageAttempt(discordId);
          const title =
            decision === "timeout"
              ? t("raid-auto-manage.enable.cancelTimeoutTitle", lang)
              : t("raid-auto-manage.enable.cancelTitle", lang);
          const cancelEmbed = new EmbedBuilder()
            .setColor(UI.colors.muted)
            .setTitle(`${UI.icons.reset} ${title}`)
            .setDescription(t("raid-auto-manage.enable.cancelDescription", lang))
            .setTimestamp();
          await interaction.editReply({ embeds: [cancelEmbed], components: [] });
        }
      } catch (err) {
        // Same reasoning as the cancel/timeout branch: probe may have already
        // sent bible requests before the throw. Stamp so cooldown still kicks
        // in for the next attempt.
        await stampAutoManageAttempt(discordId);
        console.error("[auto-manage] enable-with-sync failed:", err?.message || err);
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: t("raid-auto-manage.enable.probeFailTitle", lang),
              description: t("raid-auto-manage.enable.probeFailDescription", lang, {
                error: err?.message || err,
              }),
            }),
          ],
          components: [],
        }).catch(() => {});
      } finally {
        if (!cooldownSkip) releaseAutoManageSyncSlot(discordId);
      }
      return;
    }
    if (action === "status") {
      // Pull both modes' state through the local-sync helper so the embed
      // shows the user exactly which (if either) sync source is active +
      // freshness for each. Uses one Mongo read - helper internally
      // selects only the 6 relevant fields.
      const status = await getSyncStatus(discordId, { UserModel: User });
      // Bible mode column (existing behavior, kept).
      const bibleOptInValue = status.bible.enabled
        ? `${UI.icons.done} ${t("raid-auto-manage.status.optInOn", lang)}`
        : `${UI.icons.reset} ${t("raid-auto-manage.status.optInOff", lang)}`;
      const bibleLastSync = status.bible.lastSyncAt || 0;
      const bibleLastAttempt = status.bible.lastAttemptAt || 0;
      const bibleLastSuccessValue = bibleLastSync
        ? `<t:${Math.floor(bibleLastSync / 1000)}:R>`
        : t("raid-auto-manage.status.lastSuccessNever", lang);
      let bibleLastAttemptValue;
      if (!bibleLastAttempt) {
        bibleLastAttemptValue = t("raid-auto-manage.status.lastAttemptNever", lang);
      } else if (bibleLastAttempt === bibleLastSync) {
        bibleLastAttemptValue = t("raid-auto-manage.status.lastAttemptSameAsSuccess", lang);
      } else {
        bibleLastAttemptValue = `<t:${Math.floor(bibleLastAttempt / 1000)}:R> - ${t(
          "raid-auto-manage.status.lastAttemptFailSuffix",
          lang,
        )}`;
      }
      // Local mode column (new). Only "opt-in" + "last sync" since local
      // doesn't have a separate attempt timestamp - the web companion
      // POST is atomic, no probe + commit phases.
      const localOptInValue = status.local.enabled
        ? `${UI.icons.done} ${t("raid-auto-manage.status.localOptInOn", lang)}`
        : `${UI.icons.reset} ${t("raid-auto-manage.status.localOptInOff", lang)}`;
      const localLastSync = status.local.lastSyncAt || 0;
      const localLastSyncValue = localLastSync
        ? `<t:${Math.floor(localLastSync / 1000)}:R>`
        : t("raid-auto-manage.status.lastSuccessNever", lang);
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`${UI.icons.info} ${t("raid-auto-manage.status.title", lang)}`)
        .addFields(
          // Bible row (3 inline fields).
          { name: t("raid-auto-manage.status.optInLabel", lang), value: bibleOptInValue, inline: true },
          {
            name: t("raid-auto-manage.status.lastSuccessLabel", lang),
            value: bibleLastSuccessValue,
            inline: true,
          },
          {
            name: t("raid-auto-manage.status.lastAttemptLabel", lang),
            value: bibleLastAttemptValue,
            inline: true,
          },
          // Local row (2 inline fields). Empty 3rd field acts as a row
          // break so Discord renders local on its own line below bible.
          { name: t("raid-auto-manage.status.localOptInLabel", lang), value: localOptInValue, inline: true },
          {
            name: t("raid-auto-manage.status.localLastSyncLabel", lang),
            value: localLastSyncValue,
            inline: true,
          },
          { name: "​", value: "​", inline: true }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "sync") {
      // Acquire slot BEFORE deferReply so reply-reject is a normal reply (not editReply).
      // acquireAutoManageSyncSlot reserves the slot synchronously → no TOCTOU race between check and set.
      const guard = await acquireAutoManageSyncSlot(discordId);
      if (!guard.acquired) {
        if (guard.reason === "in-flight") {
          await interaction.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: t("raid-auto-manage.sync.inFlightTitle", lang),
                description: t("raid-auto-manage.sync.inFlightDescription", lang),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const totalCooldownText =
            typeof getAutoManageCooldownMs === "function"
              ? formatAutoManageCooldownRemaining(getAutoManageCooldownMs(discordId))
              : null;
          const cooldownLines = [
            t("raid-auto-manage.sync.cooldownLineIntro", lang),
            "",
            t("raid-auto-manage.sync.cooldownLineWait", lang, {
              remain: formatAutoManageCooldownRemaining(guard.remainingMs),
            }),
            totalCooldownText
              ? t("raid-auto-manage.sync.cooldownLineTotal", lang, {
                  totalCooldown: totalCooldownText,
                })
              : null,
            "",
            t("raid-auto-manage.sync.cooldownLineNote", lang),
          ].filter((line) => line !== null);
          await interaction.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: t("raid-auto-manage.sync.cooldownTitle", lang),
                description: cooldownLines.join("\n"),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const weekResetStart = weekResetStartMs();
        // Phase A: gather bible data OUTSIDE saveWithRetry so a VersionError
        // retry doesn't re-fire HTTP calls. The acquire guard already
        // prevents concurrent syncs for the same user, so the seedDoc we read
        // here is normally also the doc we save into - but /raid-set or
        // /raid-add-roster-char could race between read and save, triggering a
        // VersionError that the retry path can handle in-memory.
        const seedDoc = await User.findOne({ discordId });
        if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
          await interaction.editReply({
            content: null,
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: t("raid-auto-manage.sync.noRosterTitle", lang),
                description: t("raid-auto-manage.sync.noRosterDescription", lang),
              }),
            ],
          });
          return;
        }
        ensureFreshWeek(seedDoc);
        const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
        // Phase B: apply to fresh doc inside saveWithRetry - pure in-memory.
        let report;
        await saveWithRetry(async () => {
          const userDoc = await User.findOne({ discordId });
          if (!userDoc) {
            report = { noRoster: true };
            return;
          }
          if (!Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
            report = { noRoster: true };
            return;
          }
          ensureFreshWeek(userDoc);
          report = applyAutoManageCollected(userDoc, weekResetStart, collected);
          const now = Date.now();
          userDoc.lastAutoManageAttemptAt = now;
          if (report.perChar.some((c) => !c.error)) {
            userDoc.lastAutoManageSyncAt = now;
          }
          await userDoc.save();
        });
        if (report?.noRoster) {
          await interaction.editReply({
            content: null,
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: t("raid-auto-manage.sync.noRosterTitle", lang),
                description: t("raid-auto-manage.sync.noRosterDescription", lang),
              }),
            ],
          });
          return;
        }
        const embed = buildAutoManageSyncReportEmbed(report, lang);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error("[auto-manage] sync failed:", err?.message || err);
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: t("raid-auto-manage.sync.failTitle", lang),
              description: t("raid-auto-manage.sync.failDescription", lang, {
                error: err?.message || err,
              }),
            }),
          ],
        });
      } finally {
        releaseAutoManageSyncSlot(discordId);
      }
    }
  }
  /**
   * Stamp `lastAutoManageAttemptAt` without flipping any flag. Called after the
   * probe HTTP burst in cancel/timeout/error paths so the cooldown reflects
   * bible quota actually consumed - otherwise users can spam
   * `/raid-auto-manage action:on` + cancel to bypass the per-user sync cooldown.
   * Best-effort: logs and swallows DB errors so cooldown drift never masks the
   * real UX (the cancel/error message itself).
   */

  // /raid-auto-manage `action` autocomplete - filters the action set by the
  // user's current sync state so the dropdown never shows a redundant or
  // mutex-blocked option. Six actions total now (bible on/off/sync +
  // local-on/local-off + status), filtered against TWO independent flags
  // since the bible/local mutex is only enforced at write time, not state.
  // Labels resolve via the executor's locale so the dropdown text matches
  // the rest of the command's voice.
  const AUTO_MANAGE_ACTION_CHOICES = [
    {
      key: "onLabel",
      value: "on",
      // Hide when bible already on (redundant) OR local on (mutex reject).
      show: ({ bibleOn, localOn }) => !bibleOn && !localOn,
    },
    {
      key: "offLabel",
      value: "off",
      show: ({ bibleOn }) => bibleOn,
    },
    {
      key: "syncLabel",
      value: "sync",
      // Hide while local-sync is active: manual bible pulls would violate
      // the "one active source" contract. Handler also rejects stale
      // pasted values, so autocomplete is just the first UX guard.
      show: ({ localOn }) => !localOn,
    },
    {
      key: "statusLabel",
      value: "status",
      show: () => true,
    },
    {
      key: "localOnLabel",
      value: "local-on",
      // Mirror of `on`: hide when local already on OR bible on (mutex).
      show: ({ bibleOn, localOn }) => !bibleOn && !localOn,
    },
    {
      key: "localOffLabel",
      value: "local-off",
      show: ({ localOn }) => localOn,
    },
    {
      key: "resetLabel",
      value: "reset",
      // Always shown - the destructive nature is gated by the in-handler
      // confirmation prompt, not by hiding the entry. User opting in
      // OR off both have valid reset use cases (fresh re-sync from 0).
      show: () => true,
    },
  ];
  async function handleRaidAutoManageAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      let bibleOn = false;
      let localOn = false;
      try {
        const user = await User.findOne(
          { discordId: interaction.user.id },
          { autoManageEnabled: 1, localSyncEnabled: 1 }
        ).lean();
        bibleOn = !!user?.autoManageEnabled;
        localOn = !!user?.localSyncEnabled;
      } catch (err) {
        console.warn("[autocomplete] auto-manage state load failed:", err?.message || err);
      }
      const needle = normalizeName(focused.value || "");
      const choices = AUTO_MANAGE_ACTION_CHOICES
        .filter((c) => c.show({ bibleOn, localOn }))
        .map((c) => ({
          name: t(`raid-auto-manage.autocomplete.${c.key}`, lang),
          value: c.value,
        }))
        .filter((c) => {
          if (!needle) return true;
          return normalizeName(c.name).includes(needle) || normalizeName(c.value).includes(needle);
        })
        .slice(0, 25);
      await interaction.respond(choices).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-auto-manage error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  }
  /**
   * Autocomplete for /raid-announce action option. Labels annotate the
   * current per-guild state so admin knows what flipping the action will
   * actually do (e.g. "Turn on · currently OFF"), and redundant actions
   * are hidden entirely (on while on, off while off, set-channel on
   * channel-bound types, clear-channel when no override set).
   *
   * When `type` hasn't been picked yet (user focuses action first), fall
   * back to generic labels without state - Discord's choice order in the
   * command schema still ensures type is pre-required, but the autocomplete
   * runs with whatever partial values the user has entered so far.
   */
  return {
    handleRaidAutoManageCommand,
    handleRaidAutoManageAutocomplete,
  };
}

module.exports = {
  createRaidAutoManageCommand,
};
