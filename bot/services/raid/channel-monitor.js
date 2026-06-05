/**
 * services/raid/channel-monitor.js
 * Channel-monitor service: watches the registered raid channel for
 * raid-clear messages (free-form text), parses them via the text-
 * parser, applies progress to the matching character + roster, and
 * fires the whisper-ack + raid-update reply. Also drives the 30-min
 * auto-cleanup tick (clean non-pinned messages, respecting quiet
 * hours) and the welcome-embed pin maintenance.
 */

"use strict";

const {
  applyRaidChannelWritePlans,
  buildWritePlanSegments,
  findAccessibleCharacterInAccounts,
  resolveRaidChannelWritePlans,
} = require("./channel-monitor-write-plans");
const { createRaidChannelEmbedBuilders } = require("./channel-monitor-embeds");
const { parseRaidMessage } = require("./channel-monitor-parser");
const User = require("../../models/user");
const { t, getUserLanguage, getGuildLanguage } = require("../i18n");

/**
 * Build the channel-monitor service.
 * @param {object} deps - injected dependencies (Discord client +
 *   builders, Mongoose User + GuildConfig + ArtistEmoji models, text-
 *   parser, raid-set/raid-task service handles, scheduler helpers,
 *   access-control predicates · see the destructure block).
 * @returns {object} service surface · attach via the boot wiring in
 *   commands.js; see the return literal at the bottom of the function
 *   for the canonical method list (setupChannelMonitor, manual ticks
 *   for testing, the whisper-ack + reply embed builders, etc.).
 */
function createRaidChannelMonitorService({
  PermissionFlagsBits,
  EmbedBuilder,
  UI,
  GuildConfig,
  RAID_REQUIREMENT_MAP,
  getGatesForRaid,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId = null,
  getAccessibleAccounts,
  getAnnouncementsConfig,
  // Injected so checkUserMonitorCooldown / clearUserMonitorCooldown can fold
  // message.content into a stable dedup key. Missing this dep in the compose
  // site caused every MessageCreate to throw ReferenceError and the silent
  // try/catch in bot.js swallowed the error, making the whole channel appear
  // unresponsive even though the listener was bound.
  normalizeName,
}) {
  // Raid channel monitor (text-driven raid-set)
  // ---------------------------------------------------------------------------
  // In-memory per-guild cache of the monitor channel ID. The MessageCreate
  // handler fires for every message the bot can see - hitting Mongo on each
  // one would turn normal chat traffic into a DB read. The cache is loaded
  // once at boot (loadMonitorChannelCache) and updated in-place by
  // /raid-channel config action:set|clear, so the hot path can filter with
  // a Map lookup. Single-process bot → no multi-instance invalidation needed.
  const monitorChannelCache = new Map(); // guildId -> channelId | null
  // `false` until `loadMonitorChannelCache` completes successfully at least
  // once. Callers (/raid-channel config action:show) can surface this so
  // admins know a silent monitor failure is a cache-load issue, not just
  // missing config.
  let monitorCacheHealthy = false;
  let monitorCacheLoadError = null;
  async function loadMonitorChannelCache() {
    try {
      const configs = await GuildConfig.find({}).lean();
      monitorChannelCache.clear();
      for (const c of configs) {
        monitorChannelCache.set(c.guildId, c.raidChannelId || null);
      }
      monitorCacheHealthy = true;
      monitorCacheLoadError = null;
      console.log(`[raid-channel] loaded ${configs.length} guild config(s) into cache.`);
    } catch (err) {
      monitorCacheHealthy = false;
      monitorCacheLoadError = err?.message || String(err);
      // Elevate to error (not warn): this silently disables the monitor until
      // the next successful load, so operators need it to be noisy in logs.
      console.error("[raid-channel] cache load FAILED - monitor inactive until reload:", monitorCacheLoadError);
    }
  }
  function getMonitorCacheHealth() {
    return { healthy: monitorCacheHealthy, error: monitorCacheLoadError };
  }
  function getCachedMonitorChannelId(guildId) {
    return monitorChannelCache.get(guildId) ?? null;
  }
  function setCachedMonitorChannelId(guildId, channelId) {
    monitorChannelCache.set(guildId, channelId);
  }
  // Mirror of bot.js's TEXT_MONITOR_ENABLED gate so `/raid-channel` can refuse
  // to save / surface a warning in `show` when the feature is disabled at the
  // deploy layer. bot/commands.js reads process.env directly to keep bot.js as
  // the single registration surface without having to plumb a shared config.
  function isTextMonitorEnabled() {
    return process.env.TEXT_MONITOR_ENABLED !== "false";
  }
  const BOT_CHANNEL_PERMS = [
    { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
    { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
    { flag: PermissionFlagsBits.ManageMessages, label: "Manage Messages" },
    // ReadMessageHistory is required by clearPendingHint's `channel.messages.fetch(id)`
    // - without it, the fetch throws and persistent hints never auto-clean.
    { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
    // EmbedLinks is required for welcome + success embeds to render. Discord
    // silently strips embeds from bots that lack this permission, leaving
    // users with an empty or text-only message.
    { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  ];
  const ANNOUNCEMENT_CHANNEL_PERMS = [
    { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
    { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  ];
  function getMissingChannelPermissions(channel, botMember, requiredPerms) {
    if (!channel || !botMember) return requiredPerms.map((p) => p.label);
    const perms = channel.permissionsFor(botMember);
    if (!perms) return requiredPerms.map((p) => p.label);
    return requiredPerms.filter((p) => !perms.has(p.flag)).map((p) => p.label);
  }
  function getMissingBotChannelPermissions(channel, botMember, options = {}) {
    const requiredPerms = Array.isArray(options?.requiredPerms)
      ? options.requiredPerms
      : BOT_CHANNEL_PERMS;
    return getMissingChannelPermissions(channel, botMember, requiredPerms);
  }
  function getMissingAnnouncementChannelPermissions(channel, botMember) {
    return getMissingChannelPermissions(channel, botMember, ANNOUNCEMENT_CHANNEL_PERMS);
  }
  const {
    buildRaidChannelMultiResultEmbed,
    buildRaidChannelWelcomeEmbed,
  } = createRaidChannelEmbedBuilders({ EmbedBuilder, UI });
  async function postTransientReply(message, content) {
    try {
      const reply = await message.reply({ content, allowedMentions: { repliedUser: false } });
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 10_000);
    } catch (err) {
      console.warn("[raid-channel] reply failed:", err?.message || err);
    }
  }
  const emptyContentWarningAt = new Map(); // guildId:channelId -> unix ms
  const EMPTY_CONTENT_WARNING_COOLDOWN_MS = 5 * 60 * 1000;
  async function postEmptyContentWarning(message) {
    const key = `${message.guildId}:${message.channelId}`;
    const now = Date.now();
    const last = emptyContentWarningAt.get(key) || 0;
    if (now - last < EMPTY_CONTENT_WARNING_COOLDOWN_MS) return;
    emptyContentWarningAt.set(key, now);
    // Empty-content reply auto-pings the poster, so render in their
    // per-user lang. The ping is what makes them look at it; other
    // channel members are an incidental audience.
    const lang = await getUserLanguage(message.author.id, { UserModel: User });
    await postTransientReply(
      message,
      t("text-parser.emptyContent", lang, { icon: UI.icons.warn })
    );
  }
  // Persistent per-user hint tracker: when a user posts a recoverable-error
  // message, the bot pings them (reply with default repliedUser mention) and
  // keeps the hint visible until they retype. On the next message from the
  // same user in the same channel - success or a fresh error - the previous
  // hint is cleaned up. TTL auto-cleanup runs 5 minutes after post in case
  // the user never retries.
  const pendingChannelHints = new Map(); // "guildId:channelId:userId" -> { hintId, timerId }
  const HINT_TTL_MS = 5 * 60 * 1000;
  function hintKey(guildId, channelId, userId) {
    return `${guildId}:${channelId}:${userId}`;
  }
  async function clearPendingHint(channel, key) {
    const entry = pendingChannelHints.get(key);
    if (!entry) return;
    pendingChannelHints.delete(key);
    if (entry.timerId) clearTimeout(entry.timerId);
    // Delete BOTH the bot's hint reply and the user's original failed message
    // so the channel looks clean after retry. Best-effort: either may already
    // be gone (user deleted manually, hint TTL expired, etc.), swallow errors.
    const ids = [entry.hintId];
    if (entry.originalId) ids.push(entry.originalId);
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          const msg = await channel.messages.fetch(id);
          await msg.delete();
        } catch {
          // Already deleted or not fetchable - skip.
        }
      })
    );
  }
  // Per-user spam guard for the monitor channel. Silent-ignore on parse-null
  // already handles chat noise - this layer only fires on parse-success
  // messages that would actually cause bot work (hint posting, DM sending,
  // message deletion, or DB writes). Three sliding-window counters prevent
  // both accidental double-taps and deliberate spam, and the warning is
  // deduped so a sustained spammer only gets "quạo'd at" once per minute.
  const userMonitorCooldowns = new Map(); // key -> { lastProcessedAt, spamHits, spamWindowStart, warnedAt }
  const MONITOR_COOLDOWN_MS = 2000;     // min 2s between processed messages per user
  const MONITOR_SPAM_WINDOW_MS = 10000; // sliding window for counting spam hits
  const MONITOR_SPAM_THRESHOLD = 3;     // cooldown-hits within window → trigger warning

  // Per-process dedup of MessageCreate events. Set holds message ids
  // currently inside the handler's TTL window; second handler call for
  // the same id short-circuits before any side effects (channel.send,
  // DM, delete, persistent hint write). TTL = 60s, well above the ~5s
  // whisper-ack visible lifetime so dedup outlives any visible reaction.
  const recentlyHandledMessageIds = new Set();
  const DEDUP_TTL_MS = 60 * 1000;
  const MONITOR_SPAM_WARN_CD_MS = 60000;// dedup: one warning per user per minute
  /**
   * Check whether a user's message should be accepted under the per-user
   * cooldown. Content-aware with a pending-hint exception that is LIMITED
   * to one quick retry per cooldown window (otherwise the exception would
   * let a user vary content indefinitely while cooldown still theoretically
   * applies, since each failed attempt replaces the pending hint and looks
   * like a "fresh" correction flow):
   *
   *   - within cooldown + same content → DROP (duplicate spam)
   *   - within cooldown + different content + pending hint + no recent
   *     exception yet → ACCEPT via one-shot exception (round 14 typo-fix)
   *   - within cooldown + different content + exception already consumed
   *     in this window → DROP (caught by round 16 Codex as a bypass)
   *   - within cooldown + different content + no pending hint → DROP (fresh
   *     post right after a successful write; hard throttle)
   *   - outside cooldown → ACCEPT
   *
   * Returns { accepted, warn, viaException }. commitUserMonitorActivity
   * must be called right after an accept, passing `viaException` so
   * `lastExceptionAt` is bumped (or reset to 0 on a normal fresh accept).
   */
  function checkUserMonitorCooldown(message) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    const now = Date.now();
    const contentKey = normalizeName(message.content);
    const entry = userMonitorCooldowns.get(key) || {
      lastProcessedAt: 0,
      lastContent: "",
      lastExceptionAt: 0,
      spamHits: 0,
      spamWindowStart: 0,
      warnedAt: 0,
    };
    const withinCooldown = now - entry.lastProcessedAt < MONITOR_COOLDOWN_MS;
    if (withinCooldown) {
      const sameContent = contentKey && contentKey === entry.lastContent;
      const hasPendingHint = pendingChannelHints.has(key);
      const recentException = now - (entry.lastExceptionAt || 0) < MONITOR_COOLDOWN_MS;
      // Correction-flow exception - ONE retry per cooldown window, not
      // per hint (hint churn from repeated failures kept resetting the
      // per-hint flag, letting a user vary content forever).
      if (hasPendingHint && !sameContent && !recentException) {
        return { accepted: true, warn: false, viaException: true };
      }
      // Otherwise drop. Bump spam tracking and maybe emit a warning.
      if (now - entry.spamWindowStart > MONITOR_SPAM_WINDOW_MS) {
        entry.spamHits = 1;
        entry.spamWindowStart = now;
      } else {
        entry.spamHits += 1;
      }
      const shouldWarn =
        entry.spamHits >= MONITOR_SPAM_THRESHOLD &&
        now - entry.warnedAt > MONITOR_SPAM_WARN_CD_MS;
      if (shouldWarn) entry.warnedAt = now;
      userMonitorCooldowns.set(key, entry);
      return { accepted: false, warn: shouldWarn, viaException: false };
    }
    return { accepted: true, warn: false, viaException: false };
  }
  function commitUserMonitorActivity(message, viaException = false) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    const now = Date.now();
    const contentKey = normalizeName(message.content);
    const entry = userMonitorCooldowns.get(key) || {
      lastProcessedAt: 0,
      lastContent: "",
      lastExceptionAt: 0,
      spamHits: 0,
      spamWindowStart: 0,
      warnedAt: 0,
    };
    entry.lastProcessedAt = now;
    entry.lastContent = contentKey;
    // Track exception use. Fresh cooldown passes (non-exception) reset the
    // exception slot to 0 so the next hint-triggered retry gets its one shot.
    entry.lastExceptionAt = viaException ? now : 0;
    entry.spamHits = 0;
    entry.spamWindowStart = 0;
    userMonitorCooldowns.set(key, entry);
  }
  async function postSpamWarning(message) {
    try {
      // Spam reply auto-pings the spammer (Discord default reply mention),
      // so the spammer is the addressed reader. Render in their per-user
      // lang per the "bot pings X => X's lang" rule. Other channel members
      // see it incidentally; the audience-of-one (the spammer) is what
      // matters for comprehension.
      const lang = await getUserLanguage(message.author.id, { UserModel: User });
      const reply = await message.reply({
        content: t("text-parser.spamWarn", lang),
      });
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 15_000);
    } catch (err) {
      console.warn("[raid-channel] spam warning post failed:", err?.message || err);
    }
  }
  async function postPersistentHint(message, content) {
    const key = hintKey(message.guildId, message.channelId, message.author.id);
    await clearPendingHint(message.channel, key);
    try {
      const hint = await message.reply({ content });
      const timerId = setTimeout(() => {
        clearPendingHint(message.channel, key).catch(() => {});
      }, HINT_TTL_MS);
      // Track the user's original failed message too so the next clear (retry
      // success or replacement hint) wipes the whole failed exchange, not just
      // the bot's reply.
      pendingChannelHints.set(key, {
        hintId: hint.id,
        originalId: message.id,
        timerId,
      });
    } catch (err) {
      console.warn("[raid-channel] persistent hint failed:", err?.message || err);
    }
  }
  async function handleRaidChannelMessage(message) {
    // Cheap filters BEFORE touching the cache: skip DMs, system messages,
    // webhooks, bot authors, and empty content. MessageCreate fires for all
    // of these and most of them will never map to a raid intent anyway.
    if (!message) return;
    if (!message.guildId) return;
    if (message.author?.bot) return;
    if (message.system) return;
    if (message.webhookId) return;
    // Cache lookup - no Mongo hit on the hot path. Miss means no config or
    // this channel isn't the configured monitor.
    const cachedChannelId = getCachedMonitorChannelId(message.guildId);
    if (!cachedChannelId || cachedChannelId !== message.channelId) return;
    // Per-process dedup: short-circuit if we've already started handling
    // this exact message id within the TTL window. Defends against:
    //   - Discord gateway anomaly (rare; sometimes the same MessageCreate
    //     fires twice on a flaky connection)
    //   - Future internal bug that accidentally double-registers the
    //     MessageCreate listener
    // Does NOT defend against dual-instance deploys (Railway rolling
    // restart window where two containers both subscribe to the gateway)
    // because each process has its own Set — that case needs an ops fix
    // (single-replica config / stop-old-before-start-new strategy).
    if (recentlyHandledMessageIds.has(message.id)) {
      console.warn(
        `[raid-channel] duplicate handler call for message ${message.id} (author=${message.author?.id}) — dropping`
      );
      return;
    }
    recentlyHandledMessageIds.add(message.id);
    setTimeout(
      () => recentlyHandledMessageIds.delete(message.id),
      DEDUP_TTL_MS
    );
    if (!message.content || !message.content.trim()) {
      await postEmptyContentWarning(message);
      return;
    }
    const userHintKey = hintKey(message.guildId, message.channelId, message.author.id);
    const parsed = parseRaidMessage(message.content);
    if (!parsed) return; // Silent ignore: not a raid-update message.
    // Per-user cooldown gate: stops a spammer from triggering bursts of
    // postPersistentHint / DM / delete cycles. Chat noise (parse-null) is
    // already silent so unaffected. Sustained spam above threshold trips a
    // one-shot annoyed-kitsune warning, deduped per minute per user.
    //
    // The check is content-aware with a pending-hint exception, so:
    //   - Spam of duplicate content within 2s is dropped.
    //   - Typo → hint → correct-with-new-content within 2s passes through
    //     because the user has a pending hint (active correction flow).
    //   - Fresh writes back-to-back within 2s of a successful write are
    //     dropped as hard throttling.
    //
    // Commit happens immediately after a check-pass so the NEXT message
    // sees the right lastContent / timestamp, regardless of whether this
    // message ends up on the success path or an error path. Content-aware
    // logic handles the round-14 goal (retries after hints work) without
    // needing to defer the commit.
    const cooldown = checkUserMonitorCooldown(message);
    if (!cooldown.accepted) {
      if (cooldown.warn) await postSpamWarning(message);
      // Delete the throttled message so the channel doesn't accumulate
      // ignored attempts as visible text. Best-effort; swallow errors.
      message.delete().catch(() => {});
      return;
    }
    commitUserMonitorActivity(message, cooldown.viaException);
    // Resolve the poster's per-user lang once per message. Every hint /
    // whisper-ack / public DM-fallback post downstream is reply-style or
    // explicit-mention addressed to the poster, so the audience-of-one
    // is them - render in their lang. Falls back to DEFAULT_LANGUAGE
    // ("vi") on cache + DB miss. Reused as `dmLang` for the private
    // DM surface below since both are read by the same person.
    const authorLang = await getUserLanguage(message.author.id, { UserModel: User });
    if (parsed.error === "multi-gate") {
      await postPersistentHint(
        message,
        t("text-parser.multiGate", authorLang, { icon: UI.icons.warn, gates: parsed.gates.join(", ") })
      );
      return;
    }
    if (parsed.error === "multi-raid") {
      await postPersistentHint(
        message,
        t("text-parser.multiRaid", authorLang, { icon: UI.icons.warn, raids: parsed.raids.join(", ") })
      );
      return;
    }
    if (parsed.error === "multi-difficulty") {
      await postPersistentHint(
        message,
        t("text-parser.multiDifficulty", authorLang, {
          icon: UI.icons.warn,
          difficulties: parsed.difficulties.join(", "),
        })
      );
      return;
    }
    const { raidKey, modeKey, charNames, gate } = parsed;
    const raidValue = `${raidKey}_${modeKey}`;
    const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
    if (!raidMeta) {
      await postPersistentHint(
        message,
        t("text-parser.invalidCombo", authorLang, { icon: UI.icons.warn, raidKey, modeKey })
      );
      return;
    }
    if (gate) {
      const validGates = getGatesForRaid(raidMeta.raidKey);
      if (!validGates.includes(gate)) {
        await postPersistentHint(
          message,
          t("text-parser.invalidGate", authorLang, {
            icon: UI.icons.warn,
            gate,
            raidLabel: raidMeta.label,
            validGates: validGates.map((g) => `\`${g}\``).join(", "),
          })
        );
        return;
      }
    }
    if (!Array.isArray(charNames) || charNames.length === 0) {
      // Defensive - parser should have returned null in this case.
      return;
    }
    const statusType = gate ? "process" : "complete";
    // Cumulative gate expansion: posting `G2` means "cleared up to G2" in
    // Lost Ark sequential progression (G1 is a prereq for G2 in-game, so
    // you can't reach G2 without G1). Expand the single parsed gate into
    // the full prefix [G1..G_N] so one post captures the whole progress.
    let effectiveGates = [];
    if (gate) {
      const allGates = getGatesForRaid(raidMeta.raidKey);
      const gateIndex = allGates.indexOf(gate);
      effectiveGates = gateIndex >= 0 ? allGates.slice(0, gateIndex + 1) : [gate];
    }
    // Resolve shares once per message, then batch consecutive writes against
    // the same owner while preserving noRoster stop order. One message still
    // consumes one cooldown slot no matter how many chars it lists.
    const writePlans = await resolveRaidChannelWritePlans({
      authorId: message.author.id,
      charNames,
      getAccessibleAccounts,
      logger: console,
    });
    const results = await applyRaidChannelWritePlans({
      plans: writePlans,
      raidMeta,
      statusType,
      effectiveGates,
      applyRaidSetForDiscordId,
      applyRaidSetBatchForDiscordId,
      logger: console,
    });
    const hadNoRoster = results.some((r) => r.noRoster);
    if (hadNoRoster) {
      await postPersistentHint(
        message,
        t("text-parser.noRoster", authorLang, { icon: UI.icons.info })
      );
      return;
    }
    const successCount = results.filter((r) => r.updated).length;
    const alreadyCount = results.filter((r) => r.alreadyComplete).length;
    const notFoundResults = results.filter((r) => !r.matched && !r.error);
    const ineligibleResults = results.filter((r) => r.matched && !r.updated && !r.alreadyComplete);
    const errorResults = results.filter((r) => r.error);
    const hasProgress = successCount > 0 || alreadyCount > 0;
    const hasErrors =
      notFoundResults.length > 0 || ineligibleResults.length > 0 || errorResults.length > 0;
    // DM body is read by the same person as the channel hints (the
    // poster), so reuse authorLang resolved at the top of the handler -
    // avoids a redundant DB round-trip on the same user_id.
    const dmLang = authorLang;
    // Build an aggregated embed for DM - covers both single-char and multi-char
    // cases, and groups results by status so the user sees one tidy card.
    const aggregateEmbed = buildRaidChannelMultiResultEmbed({
      results,
      raidMeta,
      gates: effectiveGates,
      statusType,
      guildName: message.guild?.name,
      lang: dmLang,
    });
    // DM the aggregate for a private record. Public fallback when DM is
    // disabled. Only attempted if we actually processed something useful
    // (some progress OR enough info to be worth surfacing).
    let dmSucceeded = false;
    if (hasProgress || hasErrors) {
      try {
        await message.author.send({ embeds: [aggregateEmbed] });
        dmSucceeded = true;
      } catch (err) {
        console.warn(
          `[raid-channel] DM to ${message.author.tag || message.author.id} failed (DMs disabled?):`,
          err?.message || err
        );
      }
    }
    const ops = [];
    // When ANY error is present, post a persistent hint in the channel so
    // the user visibly gets pinged about the specific bad names - even if
    // some other names succeeded. Traine: "gõ đầu user nếu gõ sai".
    if (hasErrors) {
      const hintLines = [];
      if (notFoundResults.length > 0) {
        hintLines.push(
          t("text-parser.errorNotFound", authorLang, {
            icon: UI.icons.warn,
            names: notFoundResults.map((r) => `\`${r.charName}\``).join(", "),
          })
        );
      }
      if (ineligibleResults.length > 0) {
        hintLines.push(
          t("text-parser.errorIneligible", authorLang, {
            icon: UI.icons.warn,
            raidLabel: raidMeta.label,
            minItemLevel: raidMeta.minItemLevel,
            names: ineligibleResults
              .map((r) => `**${r.displayName || r.charName}** (iLvl ${r.ineligibleItemLevel})`)
              .join(", "),
          })
        );
      }
      if (errorResults.length > 0) {
        hintLines.push(
          t("text-parser.errorSystem", authorLang, {
            icon: UI.icons.warn,
            names: errorResults.map((r) => `\`${r.charName}\``).join(", "),
          })
        );
      }
      if (hasProgress) {
        hintLines.push(t("text-parser.errorPartialNote", authorLang));
      } else {
        hintLines.push(t("text-parser.errorRetryNote", authorLang));
      }
      ops.push(postPersistentHint(message, hintLines.join("\n")));
    }
    // Delete the source message only when there's actual progress to record.
    // If everything failed, keep the message so the user can see what they
    // posted + the hint next to it, easier to retype correctly.
    if (hasProgress) {
      // When DM was the delivery path, post a whisper acknowledgement that
      // tags the user so they realise the post was accepted (otherwise the
      // message just silently vanishes and feels like a rejection). Dusk's
      // whisper voice, but still signed as Artist per bot persona.
      // Whisper ack can be disabled per-guild via /raid-announce. Load the
      // flag BEFORE attempting send so a disabled guild skips entirely
      // (no transient message flicker while it's auto-deleted).
      let whisperAckEnabled = true;
      try {
        const cfg = await GuildConfig.findOne({ guildId: message.guildId })
          .select("announcements.whisperAck")
          .lean();
        whisperAckEnabled = getAnnouncementsConfig(cfg).whisperAck.enabled;
      } catch {
        // Read fail → default to enabled (conservative: announce rather
        // than silently drop - Traine's intent with this flow was visibility).
      }
      let whisperMsg = null;
      if (dmSucceeded && whisperAckEnabled) {
        try {
          // Whisper fires AFTER the DM has already been sent, so the
          // copy must reflect that — earlier wording said "Chờ Artist
          // 5 giây gửi qua DM" which read as if the DM was still
          // pending. The 5s delay is purely for the channel cleanup
          // window (gives the user time to see the ack before both
          // the whisper + the original post vanish).
          whisperMsg = await message.channel.send({
            content: t("text-parser.whisperAck", authorLang, { userId: message.author.id }),
            allowedMentions: { users: [message.author.id] },
          });
        } catch (err) {
          console.warn("[raid-channel] whisper confirm failed:", err?.message || err);
        }
      }
      // Delay deletion so the user has time to notice the whisper before
      // both messages disappear. Fire-and-forget - no reason to make the
      // handler sit around for 5s just to await a delete.
      setTimeout(() => {
        message.delete().catch((err) => {
          console.warn("[raid-channel] delete failed (missing Manage Messages?):", err?.message || err);
        });
        if (whisperMsg) {
          whisperMsg.delete().catch(() => {});
        }
      }, 5_000);
      // Also clear any stale pending hint from a previous bad post, now that
      // a real write landed.
      if (!hasErrors) {
        ops.push(clearPendingHint(message.channel, userHintKey));
      }
    }
    // Public fallback when DM failed AND there's progress to announce. Uses
    // channel.send with @mention so user still sees the update status when
    // their DMs are disabled. Only needed for success-path; errors already
    // post a public persistent hint above.
    if (hasProgress && !dmSucceeded) {
      const scope = effectiveGates.length > 0
        ? `${raidMeta.label} · ${effectiveGates.join(", ")}`
        : raidMeta.label;
      const doneNames = results
        .filter((r) => r.updated)
        .map((r) => `**${r.displayName || r.charName}**`)
        .join(", ");
      const alreadyNames = results
        .filter((r) => r.alreadyComplete)
        .map((r) => `**${r.displayName || r.charName}**`)
        .join(", ");
      const parts = [];
      if (doneNames) {
        parts.push(t("text-parser.dmFallbackMarkDone", authorLang, { scope, names: doneNames }));
      }
      if (alreadyNames) {
        parts.push(t("text-parser.dmFallbackAlready", authorLang, { scope, names: alreadyNames }));
      }
      const fallbackText = t("text-parser.dmFallback", authorLang, {
        icon: UI.icons.done,
        userId: message.author.id,
        parts: parts.join("; "),
      });
      ops.push(
        (async () => {
          try {
            const fallback = await message.channel.send({
              content: fallbackText,
              allowedMentions: { users: [message.author.id] },
            });
            setTimeout(() => fallback.delete().catch(() => {}), 15_000);
          } catch (err) {
            console.warn("[raid-channel] DM fallback post failed:", err?.message || err);
          }
        })()
      );
    }
    await Promise.allSettled(ops);
  }
  /**
   * Delete every non-pinned message in the raid monitor channel. Paginates
   * through channel history via the `before` cursor in 100-message batches
   * (Discord's per-fetch cap) so busy channels with more than 100 messages
   * get cleaned all the way back. Uses `bulkDelete(messages, true)` so
   * messages older than 14 days are silently filtered out and counted as
   * `skippedOld` instead of failing the batch.
   *
   * Caller must verify the bot has Manage Messages + Read Message History
   * in the channel. Safety cap of 20 iterations (max 2000 messages per run)
   * prevents a runaway if history is unexpectedly huge - for a raid-clear
   * channel that's well above any realistic size.
   */
  async function cleanupRaidChannelMessages(channel) {
    const MAX_ITERATIONS = 20;
    let totalDeleted = 0;
    let totalSkippedOld = 0;
    let before;
    for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
      const fetchOpts = { limit: 100 };
      if (before) fetchOpts.before = before;
      const fetched = await channel.messages.fetch(fetchOpts);
      if (fetched.size === 0) break;
      // Advance the pagination cursor to the oldest message in this batch,
      // regardless of whether we can delete any of it - this prevents an
      // infinite loop when a batch is all pinned.
      before = fetched.last()?.id;
      const toDelete = fetched.filter((m) => !m.pinned);
      if (toDelete.size > 0) {
        const deleted = await channel.bulkDelete(toDelete, true);
        totalDeleted += deleted.size;
        totalSkippedOld += toDelete.size - deleted.size;
      }
      // Less than a full batch means we reached the end of channel history.
      if (fetched.size < 100) break;
    }
    return { deleted: totalDeleted, skippedOld: totalSkippedOld };
  }
  /**
   * Unpin the stored welcome message (if any), then post + pin a fresh
   * welcome embed. Used by both `/raid-channel config action:set` (initial
   * welcome) and `/raid-channel config action:repin` (manual refresh). The
   * new welcome's message ID is persisted to `GuildConfig.welcomeMessageId`
   * so the next invocation can identify the exact pin to remove instead of
   * scanning every bot-authored pin (which would also tear down unrelated
   * bot pins).
   *
   * Returns an object reporting which steps succeeded so the caller can
   * decide whether to surface a warning to the admin.
   */
  async function postRaidChannelWelcome(channel, botUserId, guildId) {
    const outcome = { posted: false, pinned: false, persisted: false, removedOldCount: 0 };
    // Collect every STALE welcome we should delete when the fresh welcome
    // is safely in place. Two sources combined into a Set to dedupe:
    //   1. The DB-tracked `welcomeMessageId` - primary, explicit reference.
    //   2. Signature-match scan of currently-pinned bot messages whose
    //      embed title matches the welcome signature - catches orphans
    //      from earlier versions that pinned without DB tracking (exactly
    //      the case where real-user saw 2 pinned welcomes after round 17
    //      fix didn't clean up the pre-fix orphan).
    // Both collected BEFORE post/pin/persist of the new one, so the
    // fresh welcome's id (generated after this block) is guaranteed NOT
    // in the stale set.
    const staleIds = new Set();
    if (guildId) {
      try {
        const cfg = await GuildConfig.findOne({ guildId }).lean();
        if (cfg?.welcomeMessageId) staleIds.add(cfg.welcomeMessageId);
      } catch (err) {
        console.warn("[raid-channel] GuildConfig read for welcomeMessageId failed:", err?.message || err);
      }
    }
    try {
      // discord.js v14.18+ replaced the deprecated `fetchPinned()`
      // (which returned a Collection<id, Message>) with `fetchPins()`,
      // whose response shape is `{ items: MessagePin[], hasMore }` —
      // `items` is a plain array (NOT a Collection), and each entry is
      // a MessagePin wrapping the actual Message under `.message`.
      // Iterating the response object directly throws "pinned is not
      // iterable"; destructuring `[, msg]` from a MessagePin would also
      // give garbage. Discord caps pinned messages at 50 per channel
      // and one fetch returns up to 50, so `hasMore` is safely ignored
      // for the welcome-scan use case.
      const { items: pins = [] } = await channel.messages.fetchPins();
      for (const pin of pins) {
        const msg = pin?.message;
        if (!msg || msg.author?.id !== botUserId) continue;
        const title = msg.embeds?.[0]?.title || "";
        // Welcome title signature has been localized - match the per-locale
        // signature words so JP/EN welcomes still get cleaned up alongside
        // the legacy VN one. The ja/en titles share a common keyword
        // ("Artist") that the VN one also contains, but we match each one
        // explicitly to avoid false positives on unrelated bot pins that
        // happen to contain "Artist".
        if (
          title.includes("Artist ngồi trông channel này") ||
          title.includes("アーティストがこのチャンネルを見守りますわ") ||
          title.includes("Artist watches this channel")
        ) {
          staleIds.add(msg.id);
        }
      }
    } catch (err) {
      console.warn("[raid-channel] fetchPins for stale-welcome scan failed:", err?.message || err);
    }
    // Welcome embed is a channel-wide broadcast (no specific user pinged),
    // so it stays on the guild's broadcast language. New GuildConfig docs
    // (no language field yet) fall back to "vi" via getGuildLanguage's
    // defaults, matching the legacy behavior.
    const guildLang = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
    const embed = buildRaidChannelWelcomeEmbed(guildLang);
    try {
      const sent = await channel.send({ embeds: [embed] });
      outcome.posted = true;
      try {
        await sent.pin();
        outcome.pinned = true;
        // Only persist the new welcome ID after BOTH post AND pin succeed.
        // Persist failure rolls back the fresh pin (best-effort unpin) so
        // the DB and channel state stay coherent - otherwise we'd end up
        // with a pinned-in-channel-but-not-tracked-in-DB welcome that the
        // next repin can't find, letting stale pins accumulate over time.
        if (guildId) {
          try {
            await GuildConfig.findOneAndUpdate(
              { guildId },
              { $set: { welcomeMessageId: sent.id } },
              { upsert: true, setDefaultsOnInsert: true }
            );
            outcome.persisted = true;
          } catch (err) {
            console.warn("[raid-channel] persist welcomeMessageId failed:", err?.message || err);
            try {
              await sent.unpin();
            } catch (unpinErr) {
              console.warn("[raid-channel] rollback-unpin after persist fail also failed:", unpinErr?.message || unpinErr);
            }
            outcome.pinned = false;
          }
        } else {
          // No guildId was passed - we can't persist, so treat as
          // persist-succeeded for unpin purposes (caller opted out of
          // tracking).
          outcome.persisted = true;
        }
      } catch (err) {
        console.warn("[raid-channel] pin fresh welcome failed:", err?.message || err);
      }
    } catch (err) {
      console.warn("[raid-channel] post welcome failed:", err?.message || err);
    }
    // Remove every stale welcome only after the new one is post + pin +
    // persist confirmed. Any partial failure on the fresh-welcome side
    // leaves the stale set alone so the channel still has guidance AND
    // the next repin can retry cleanup.
    //
    // `message.delete()` is used instead of just `unpin()` because each
    // stale welcome is a bot-authored onboarding embed - leaving them as
    // regular (unpinned) messages would clutter the channel with multiple
    // welcomes, which is exactly what repin is supposed to prevent. Delete
    // also automatically removes from the pin list.
    if (outcome.posted && outcome.pinned && outcome.persisted && staleIds.size > 0) {
      for (const id of staleIds) {
        try {
          const oldMsg = await channel.messages.fetch(id);
          await oldMsg.delete();
          outcome.removedOldCount += 1;
        } catch {
          // Stale welcome is already gone (deleted manually, channel
          // cleanup, etc.) - skip.
        }
      }
    }
    return outcome;
  }
  async function resolveRaidMonitorChannel(interaction, channelId) {
    let channel = interaction.guild?.channels?.cache?.get(channelId) || null;
    if (!channel && interaction.guild?.channels?.fetch) {
      try {
        channel = await interaction.guild.channels.fetch(channelId);
      } catch {
        channel = null;
      }
    }
    return channel;
  }

  return {
    loadMonitorChannelCache,
    getMonitorCacheHealth,
    getCachedMonitorChannelId,
    setCachedMonitorChannelId,
    isTextMonitorEnabled,
    getMissingBotChannelPermissions,
    getMissingAnnouncementChannelPermissions,
    parseRaidMessage,
    handleRaidChannelMessage,
    cleanupRaidChannelMessages,
    postRaidChannelWelcome,
    resolveRaidMonitorChannel,
  };
}

module.exports = {
  createRaidChannelMonitorService,
  _test: {
    findAccessibleCharacterInAccounts,
    resolveRaidChannelWritePlans,
    applyRaidChannelWritePlans,
    buildWritePlanSegments,
  },
};
