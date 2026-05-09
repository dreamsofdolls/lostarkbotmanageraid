const { getClassEmoji } = require("../../models/Class");
const { pack2Columns, formatProgressTotals } = require("../../utils/raid/shared");
const { t } = require("../../services/i18n");

function createRaidStatusView(deps) {
  const {
    EmbedBuilder,
    UI,
    getCharacterName,
    truncateText,
    formatNextCooldownRemaining,
    summarizeRaidProgress,
    summarizeAccountGold,
    formatGold,
    formatRaidStatusLine,
    formatRosterRefreshCooldownRemaining,
    ROSTER_REFRESH_COOLDOWN_MS,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
    getRosterRefreshCooldownMs,
    isManagerId,
  } = deps;

  // Manager rosters get a 👑 at the account header (swapping the default
  // 📁 folder icon) instead of stamping every character name with a crown.
  // Per-char crown was scan-hostile once there were many chars and collides
  // with the planned class-icon swap for the char name slot, so the visual
  // cue lives at the roster boundary where it only appears once per group.
  function pickRosterHeaderIcon(discordId) {
    return isManagerId && isManagerId(discordId) ? "👑" : UI.icons.roster;
  }

  // Footer shows subject-scoped rollup (done/partial/pending across the
  // viewed user's entire roster) + optional page counter, matching
  // /raid-check's footer semantics. In /raid-status the "subject" is the
  // caller themselves, so counts stay identical across pagination pages;
  // the `pageInfo` tail appends only when totalPages > 1.
  function buildStatusFooterText(globalTotals, pageInfo = null, lang) {
    const { completed = 0, partial = 0, total = 0 } = globalTotals?.progress || {};
    const pending = Math.max(0, total - completed - partial);
    // Shared formatter for the `🟢 N done · 🟡 N · ⚪ N` icon line so
    // /raid-status + /raid-check render with identical icon ordering /
    // spacing. Page indicator stays surface-specific (only multi-page
    // /raid-status appends it).
    let line = formatProgressTotals(
      { done: completed, partial, pending },
      UI,
      lang,
    );
    if (pageInfo && Number(pageInfo.totalPages) > 1) {
      line += t("raid-status.embed.pageSuffix", lang, {
        current: Number(pageInfo.pageIndex) + 1,
        total: Number(pageInfo.totalPages),
      });
    }
    return line;
  }

  // Gold line per character card - renders only for gold-earners with at
  // least one eligible raid this week. Non-earners emit no line at all:
  // the header already carries the 💰 marker (its absence signals "not
  // gold-earner") so a dedicated body line would just clutter the card.
  function buildCharacterGoldLine(character, raids) {
    if (!Array.isArray(raids) || raids.length === 0) return null;
    if (!character?.isGoldEarner) return null;
    let earned = 0;
    let total = 0;
    for (const raid of raids) {
      earned += Number(raid?.earnedGold) || 0;
      total += Number(raid?.totalGold) || 0;
    }
    if (total <= 0) return null;
    return `💰 ${formatGold(earned)} / ${formatGold(total)}`;
  }

  function buildCharacterField(character, getRaidsFor, lang) {
    const name = getCharacterName(character);
    const itemLevel = Number(character.itemLevel) || 0;
    // Class emoji prepended to char name when the class is mapped in
    // CLASS_EMOJI_MAP. Empty string fallback when unmapped - safe no-op
    // so the field renders cleanly while emoji are still being uploaded.
    const classIcon = getClassEmoji(character.class);
    const namePrefix = classIcon ? `${classIcon} ` : "";
    const fieldName = truncateText(`${namePrefix}${name} · ${itemLevel}`, 256);

    const raids = getRaidsFor(character);
    const lines = raids.length === 0
      ? [`${UI.icons.lock} ${t("raid-status.embed.notEligible", lang)}`]
      : raids.map((raid) => formatRaidStatusLine(raid, lang));

    const goldLine = buildCharacterGoldLine(character, raids);
    if (goldLine) lines.push(goldLine);

    return {
      name: fieldName,
      value: truncateText(lines.join("\n"), 1024),
      inline: true,
    };
  }

  function buildAccountFreshnessLine(account, userMeta, lang) {
    const parts = [];
    const lastRefreshedAt = Number(account?.lastRefreshedAt) || 0;
    if (lastRefreshedAt > 0) {
      // Discord native timestamp `<t:UNIX:R>` ticks client-side - browser
      // refreshes the relative string every second without a server-side
      // re-render. Replaces the static `formatShortRelative()` snapshot
      // so the freshness line stays accurate even after the user has
      // been staring at the embed for a minute.
      const lastUpdatedTs = `<t:${Math.floor(lastRefreshedAt / 1000)}:R>`;
      const lastUpdatedLabel = t("raid-status.freshness.lastUpdated", lang);
      const lastUpdated = `${UI.icons.roster} ${lastUpdatedLabel} ${lastUpdatedTs}`;
      // Manager (in RAID_MANAGER_ID allowlist) gets a 10-min refresh
      // cooldown vs 2h for regular users so the operational refresh path
      // mirrors the per-user cooldown they'd actually hit. Falls back to
      // the conservative 2h default when the helper isn't wired in
      // (older deps shape, tests).
      const refreshCooldownMs =
        typeof getRosterRefreshCooldownMs === "function" && userMeta?.discordId
          ? getRosterRefreshCooldownMs(userMeta.discordId)
          : ROSTER_REFRESH_COOLDOWN_MS;
      const remain = formatRosterRefreshCooldownRemaining(account, refreshCooldownMs);
      if (remain) {
        // `lastRefreshAttemptAt` (or lastRefreshedAt if no attempt
        // recorded) + cooldown is the moment the next refresh becomes
        // eligible; render that as another <t:R> so "in Xm" ticks down
        // toward zero in real time.
        const cooldownMs = refreshCooldownMs;
        const cursor =
          Number(account?.lastRefreshAttemptAt) ||
          Number(account?.lastRefreshedAt) ||
          0;
        const nextEligible = cursor + cooldownMs;
        const nextTs = `<t:${Math.floor(nextEligible / 1000)}:R>`;
        const refreshReadyLabel = t("raid-status.freshness.refreshReady", lang);
        parts.push(`${lastUpdated} · ⏳ ${refreshReadyLabel} ${nextTs}`);
      } else {
        const refreshReadyNowLabel = t("raid-status.freshness.refreshReadyNow", lang);
        parts.push(`${lastUpdated} · ✅ ${refreshReadyNowLabel}`);
      }
    }

    // Auto-manage state belongs to the account *owner*, not the viewer.
    // On shared pages the auto-sync line would render B's settings on
    // A's roster, which is misleading. Hide the line for shared
    // accounts; rely on the title's "Shared by ..." badge to signal
    // why sync info is absent.
    const isShared = !!account?._sharedFrom;
    if (!isShared && userMeta?.autoManageEnabled) {
      const lastSyncAt = Number(userMeta?.lastAutoManageSyncAt) || 0;
      const lastSyncLabel = t("raid-status.freshness.lastSynced", lang);
      const neverSyncedLabel = t("raid-status.freshness.neverSynced", lang);
      const lastSync =
        lastSyncAt > 0
          ? `${UI.icons.reset} ${lastSyncLabel} <t:${Math.floor(lastSyncAt / 1000)}:R>`
          : `${UI.icons.reset} ${neverSyncedLabel}`;
      // Manager (in RAID_MANAGER_ID allowlist) has a 15s sync cooldown vs 10m
      // for regular users - the countdown must reflect the per-user value or
      // it would mislead managers into waiting minutes after a click when
      // they're actually sync-ready within seconds.
      const cooldownMs =
        typeof getAutoManageCooldownMs === "function" && userMeta?.discordId
          ? getAutoManageCooldownMs(userMeta.discordId)
          : AUTO_MANAGE_SYNC_COOLDOWN_MS;
      const lastAttempt = Number(userMeta?.lastAutoManageAttemptAt) || 0;
      const remain = formatNextCooldownRemaining(lastAttempt, cooldownMs);
      if (remain) {
        const nextEligible = lastAttempt + cooldownMs;
        const nextTs = `<t:${Math.floor(nextEligible / 1000)}:R>`;
        const syncReadyLabel = t("raid-status.freshness.syncReady", lang);
        parts.push(`${lastSync} · ⏳ ${syncReadyLabel} ${nextTs}`);
      } else {
        const syncReadyNowLabel = t("raid-status.freshness.syncReadyNow", lang);
        parts.push(`${lastSync} · ✅ ${syncReadyNowLabel}`);
      }
    }

    // Render refresh segment + sync segment on SEPARATE lines instead of
    // joining with " · " on one line. The combined line was getting wide
    // (4 sub-segments × ~15 chars each = ~60 chars) and harder to scan
    // because refresh + sync are distinct concepts (roster metadata vs
    // bible logs) on different cooldown clocks. Stacking them visually
    // mirrors the conceptual split.
    return parts.join("\n");
  }

  // Map the piggyback outcome captured during handleRaidStatusCommand
  // into a single description line. Returns null when the line would
  // add noise without information (no piggyback was attempted, or it
  // ran cleanly but found nothing new - the freshness line above
  // already covers the "data is fresh" case).
  //
  // Voice: Artist persona (per CLAUDE.md memory) - friendly first-person
  // "tớ"/"Artist" framing instead of neutral status copy. Locale pack
  // owns the wording per language; this function only routes outcomes
  // to the right translation key.
  function buildPiggybackOutcomeLine(piggybackOutcome, lang) {
    if (!piggybackOutcome) return null;
    switch (piggybackOutcome.outcome) {
      case "applied": {
        const n = piggybackOutcome.newGatesApplied || 0;
        return `${UI.icons.reset} ${t("raid-status.piggyback.applied", lang, { n })}`;
      }
      case "synced-no-new":
        return `${UI.icons.done} ${t("raid-status.piggyback.syncedNoNew", lang)}`;
      case "timeout":
        return `⏳ ${t("raid-status.piggyback.timeout", lang)}`;
      case "failed":
        return `${UI.icons.warn} ${t("raid-status.piggyback.failed", lang)}`;
      case "cooldown":
      case "not-applicable":
      default:
        return null;
    }
  }

  function buildAccountPageEmbed(
    account,
    pageIndex,
    totalPages,
    globalTotals,
    getRaidsFor,
    userMeta = null,
    options = {}
  ) {
    // Lang threads through every render path. Default to the system
    // default ("vi") so older callers that haven't been migrated yet
    // still get sensible output - i18n.t() falls back gracefully.
    const { hideIneligibleChars = false, lang = "vi" } = options;
    const characters = Array.isArray(account.characters) ? account.characters : [];

    const accountRaids = [];
    for (const character of characters) {
      accountRaids.push(...getRaidsFor(character));
    }
    const accountProgress = summarizeRaidProgress(accountRaids);

    const titleIcon = accountProgress.total === 0
      ? UI.icons.lock
      : accountProgress.completed === accountProgress.total
        ? UI.icons.done
        : accountProgress.completed + accountProgress.partial > 0
          ? UI.icons.partial
          : UI.icons.pending;

    // Shared rosters surface with a 👥 header icon (instead of the
    // owner-roster 👑/📁) and a "Shared by ..." suffix so the viewer
    // immediately reads the page as not-their-own. Owner-A's auto-sync
    // state is also hidden because the badge belongs to A's account
    // settings, not B's; rendering A's setting on B's view would mislead.
    const sharedFrom = account._sharedFrom;
    const isShared = !!sharedFrom;
    const headerIcon = isShared ? "👥" : pickRosterHeaderIcon(userMeta?.discordId);
    // Inline `· 📝 Auto-sync OFF` badge when the rendered subject hasn't
    // opted into /raid-auto-manage. Strict `=== false` so a missing/unknown
    // flag (legacy doc) doesn't false-positive into showing OFF. Skipped
    // on shared pages because the auto-sync flag belongs to owner A.
    const autoSyncBadge =
      !isShared && userMeta?.autoManageEnabled === false
        ? t("raid-status.embed.autoSyncOffBadge", lang)
        : "";
    const sharedBadge = isShared
      ? t("raid-status.embed.sharedBySuffix", lang, {
          owner: sharedFrom.ownerLabel || "(unknown)",
          // Localize the access level (edit / view) so the badge tail
          // reads natively in each language - "(編集可)" for JP, "(chỉnh
          // sửa)" for VN, "(edit)" for EN. Fall back to the raw level
          // string if the lookup misses (e.g. unknown grant type).
          level: t(
            `share.accessLevel.${sharedFrom.accessLevel || "edit"}`,
            lang,
          ),
        })
      : "";
    const title = `${titleIcon} ${headerIcon} ${account.accountName}${autoSyncBadge}${sharedBadge}`;

    const descriptionLines = [];
    if (totalPages > 1) {
      // Cross-account rollup. Suppressed when total <= 0 so an
      // all-non-earner roster doesn't render a misleading "💰 0G / 0G".
      const globalGoldTotal = Number(globalTotals?.gold?.total) || 0;
      const globalGoldEarned = Number(globalTotals?.gold?.earned) || 0;
      const globalGoldTail = globalGoldTotal > 0
        ? ` · 💰 **${formatGold(globalGoldEarned)} / ${formatGold(globalGoldTotal)}**`
        : "";
      descriptionLines.push(
        t("raid-status.embed.allAccounts", lang, {
          chars: globalTotals.characters,
          done: globalTotals.progress.completed,
          total: globalTotals.progress.total,
          goldTail: globalGoldTail,
        }),
      );
    }
    // Per-account gold rollup. Always emitted on accounts with at least
    // one gold-earner.
    if (typeof summarizeAccountGold === "function") {
      const accountGold = summarizeAccountGold(account, getRaidsFor);
      if (accountGold.total > 0) {
        descriptionLines.push(
          t("raid-status.embed.earnedThisWeek", lang, {
            earned: formatGold(accountGold.earned),
            total: formatGold(accountGold.total),
          }),
        );
      }
    }
    const freshnessLine = buildAccountFreshnessLine(account, userMeta, lang);
    if (freshnessLine) descriptionLines.push(freshnessLine);

    // Discoverability hint for /raid-gold-earner. Shown ONLY when the
    // account has at least one eligible char (>= 1 raid unlocked at
    // current iLvl) that isn't yet a gold-earner.
    const eligibleNonEarnerCount = (account.characters || []).filter(
      (c) => !c?.isGoldEarner && getRaidsFor(c).length > 0
    ).length;
    if (eligibleNonEarnerCount > 0) {
      descriptionLines.push(t("raid-status.embed.goldEarnerHint", lang));
    }

    const outcomeLine = buildPiggybackOutcomeLine(userMeta?.piggybackOutcome, lang);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(accountProgress.color)
      .setFooter({
        text: buildStatusFooterText(globalTotals, { pageIndex, totalPages }, lang),
      })
      .setTimestamp();

    if (descriptionLines.length > 0) {
      embed.setDescription(descriptionLines.join("\n"));
    }

    const appendOutcomeField = () => {
      if (outcomeLine) {
        embed.addFields({ name: "​", value: outcomeLine, inline: false });
      }
    };

    if (characters.length === 0) {
      embed.addFields({
        name: "​",
        value: t("raid-status.embed.noCharacters", lang),
        inline: false,
      });
      appendOutcomeField();
      return embed;
    }

    const visibleChars = hideIneligibleChars
      ? characters.filter((c) => getRaidsFor(c).length > 0)
      : characters;

    if (visibleChars.length === 0 && hideIneligibleChars) {
      embed.addFields({
        name: "​",
        value: `${UI.icons.lock} ${t("raid-status.embed.allIneligible", lang)}`,
        inline: false,
      });
      appendOutcomeField();
      return embed;
    }

    embed.addFields(
      ...pack2Columns(visibleChars.map((c) => buildCharacterField(c, getRaidsFor, lang)))
    );

    appendOutcomeField();
    return embed;
  }

  return {
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
  };
}

module.exports = { createRaidStatusView };
