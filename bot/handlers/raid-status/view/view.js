/**
 * handlers/raid-status/view.js
 * View layer for /raid-status · builds the per-roster embed (one
 * page per account) with raid progress, weekly gold rollup, side-
 * task badges, and the navigation/filter components. Localised via
 * the i18n service so each rendered page reflects the caller's
 * (or grantee's) preferred language.
 */

const { getClassEmoji } = require("../../../models/Class");
const { pack2Columns, formatProgressTotals } = require("../../../utils/raid/common/shared");
const { t, tPick } = require("../../../services/i18n");

function numberOrZero(value) {
  return Number(value) || 0;
}

/**
 * Build the /raid-status view service.
 * @param {object} deps - injected dependencies (discord.js builders +
 *   UI tokens, raid catalogue, task helpers · see destructure)
 * @returns {object} service surface · see the return literal for the
 *   canonical method list (buildStatusEmbed, buildStatusComponents,
 *   etc.)
 */
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
  } = deps;

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
  // gold-earner"), so a second body line would duplicate that state.
  function resolveEarnedBoundGold(raid, earnedGold) {
    const explicitBound = numberOrZero(raid?.earnedBoundGold);
    if (explicitBound) return explicitBound;
    return raid?.goldBound ? earnedGold : 0;
  }

  function buildCharacterGoldLine(character, raids, lang) {
    if (!Array.isArray(raids) || raids.length === 0) return [];
    if (!character?.isGoldEarner) return [];
    let earned = 0;
    let total = 0;
    let earnedBound = 0;
    for (const raid of raids) {
      const e = numberOrZero(raid?.earnedGold);
      earned += e;
      total += numberOrZero(raid?.totalGold);
      // Mirror summarizeCharacterGold: a reduced-normal raid pays half its gold
      // bound, so use the per-raid earnedBoundGold split. Falling back to the
      // whole-raid amount only for fully-bound modes / bare test raids that
      // predate the split field - otherwise the bound half goes uncounted.
      earnedBound += resolveEarnedBoundGold(raid, e);
    }
    if (total <= 0) return [];
    // Disjoint buckets: 💰 = tradeable (unbound) gold, 🔒 = roster-bound gold.
    // The two amounts never overlap (they sum to the total) so the bound part
    // reads as separate, not as a slice of the 💰 number.
    const boundTail = earnedBound > 0
      ? t("raid-status.embed.goldBoundTail", lang, { bound: formatGold(earnedBound) })
      : "";
    return [`💰 ${formatGold(earned - earnedBound)}${boundTail}`];
  }

  function buildBoundGoldTail(gold, lang) {
    const totalBound = numberOrZero(gold?.totalBound);
    if (totalBound <= 0) return "";
    const earnedBound = numberOrZero(gold?.earnedBound);
    return t("raid-status.embed.goldBoundTail", lang, {
      bound: `${formatGold(earnedBound)} / ${formatGold(totalBound)}`,
    });
  }

  function buildCharacterField(character, getRaidsFor, lang, options = {}) {
    const { showGold = true } = options;
    const name = getCharacterName(character);
    const itemLevel = Number(character.itemLevel) || 0;
    // Class emoji prepended to char name when the class is mapped in
    // CLASS_EMOJI_MAP. Empty string fallback when unmapped - safe no-op
    // so the field renders cleanly while emoji are still being uploaded.
    const classIcon = getClassEmoji(character.class || character.className);
    const namePrefix = classIcon ? `${classIcon} ` : "";
    const fieldName = truncateText(`${namePrefix}${name} · ${itemLevel}`, 256);

    const raids = getRaidsFor(character);
    const lines = raids.length === 0
      ? [`${UI.icons.lock} ${t("raid-status.embed.notEligible", lang)}`]
      : raids.map((raid) => formatRaidStatusLine(raid, lang));

    if (showGold) {
      lines.push(...buildCharacterGoldLine(character, raids, lang));
    }

    return {
      name: fieldName,
      value: truncateText(lines.join("\n"), 1024),
      inline: true,
    };
  }

  function resolveUserCooldown(getCooldownMs, discordId, fallbackMs) {
    if (typeof getCooldownMs !== "function" || !discordId) return fallbackMs;
    return getCooldownMs(discordId);
  }

  function buildRosterFreshnessLine(account, userMeta, lang) {
    const lastRefreshedAt = numberOrZero(account?.lastRefreshedAt);
    if (lastRefreshedAt <= 0) return "";

    const lastUpdated = `${UI.icons.roster} ${t("raid-status.freshness.lastUpdated", lang)} <t:${Math.floor(lastRefreshedAt / 1000)}:R>`;
    const cooldownMs = resolveUserCooldown(
      getRosterRefreshCooldownMs,
      userMeta?.discordId,
      ROSTER_REFRESH_COOLDOWN_MS
    );
    const remain = formatRosterRefreshCooldownRemaining(account, cooldownMs);
    if (!remain) {
      return `${lastUpdated} · ✅ ${t("raid-status.freshness.refreshReadyNow", lang)}`;
    }

    const cursor = numberOrZero(account?.lastRefreshAttemptAt) || lastRefreshedAt;
    const nextTs = `<t:${Math.floor((cursor + cooldownMs) / 1000)}:R>`;
    return `${lastUpdated} · ⏳ ${t("raid-status.freshness.refreshReady", lang)} ${nextTs}`;
  }

  function buildAutoManageFreshnessLine(account, userMeta, lang) {
    if (account?._sharedFrom || !userMeta?.autoManageEnabled) return "";

    const lastSyncAt = numberOrZero(userMeta?.lastAutoManageSyncAt);
    const lastSync = lastSyncAt > 0
      ? `${UI.icons.reset} ${t("raid-status.freshness.lastSynced", lang)} <t:${Math.floor(lastSyncAt / 1000)}:R>`
      : `${UI.icons.reset} ${t("raid-status.freshness.neverSynced", lang)}`;
    const cooldownMs = resolveUserCooldown(
      getAutoManageCooldownMs,
      userMeta?.discordId,
      AUTO_MANAGE_SYNC_COOLDOWN_MS
    );
    const lastAttempt = numberOrZero(userMeta?.lastAutoManageAttemptAt);
    const remain = formatNextCooldownRemaining(lastAttempt, cooldownMs);
    if (!remain) {
      return `${lastSync} · ✅ ${t("raid-status.freshness.syncReadyNow", lang)}`;
    }

    const nextTs = `<t:${Math.floor((lastAttempt + cooldownMs) / 1000)}:R>`;
    return `${lastSync} · ⏳ ${t("raid-status.freshness.syncReady", lang)} ${nextTs}`;
  }

  function buildAccountFreshnessLine(account, userMeta, lang) {
    return [
      buildRosterFreshnessLine(account, userMeta, lang),
      buildAutoManageFreshnessLine(account, userMeta, lang),
    ].filter(Boolean).join("\n");
  }

  // Map the piggyback outcome captured during handleRaidStatusCommand
  // into a single description line. Returns null when the line would
  // duplicate existing information (no piggyback was attempted, or it
  // completed without new data - the freshness line above
  // already covers the "data is fresh" case).
  //
  // Public wording is owned by the locale packs. This function only maps
  // sync outcomes to translation keys.
  function buildPiggybackOutcomeLine(piggybackOutcome, lang) {
    if (!piggybackOutcome) return null;
    switch (piggybackOutcome.outcome) {
      case "applied": {
        const n = piggybackOutcome.newGatesApplied || 0;
        return `${UI.icons.reset} ${tPick("raid-status.piggyback.applied", lang, { n })}`;
      }
      case "synced-no-new":
        return `${UI.icons.done} ${tPick("raid-status.piggyback.syncedNoNew", lang)}`;
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

  function resolveProgressIcon(progress) {
    if (progress.total === 0) return UI.icons.lock;
    if (progress.completed === progress.total) return UI.icons.done;
    if (progress.completed + progress.partial > 0) return UI.icons.partial;
    return UI.icons.pending;
  }

  function summarizeAccountProgress(characters, getProgressRaidsFor) {
    const accountRaids = [];
    for (const character of characters) {
      accountRaids.push(...getProgressRaidsFor(character));
    }
    return summarizeRaidProgress(accountRaids);
  }

  function resolveSyncModeBadge(sharedFrom, userMeta, lang) {
    if (sharedFrom) return "";
    if (userMeta?.localSyncEnabled === true) {
      return t("raid-status.embed.localSyncOnBadge", lang);
    }
    if (userMeta?.autoManageEnabled === true) {
      return t("raid-status.embed.autoSyncOnBadge", lang);
    }
    return "";
  }

  function buildSharedRosterBadge(sharedFrom, lang) {
    if (!sharedFrom) return "";
    return t("raid-status.embed.sharedBySuffix", lang, {
      owner: sharedFrom.ownerLabel || "(unknown)",
      level: t(
        `share.accessLevel.${sharedFrom.accessLevel || "edit"}`,
        lang,
      ),
    });
  }

  function buildAccountTitle(account, accountProgress, userMeta, lang) {
    const sharedFrom = account._sharedFrom;
    const syncModeBadge = resolveSyncModeBadge(sharedFrom, userMeta, lang);
    const sharedBadge = buildSharedRosterBadge(sharedFrom, lang);
    return `${resolveProgressIcon(accountProgress)} ${account.accountName}${syncModeBadge}${sharedBadge}`;
  }

  function normalizeGlobalRollup(globalTotals) {
    const root = globalTotals || {};
    const progress = root.progress || {};
    const soloProgress = root.soloProgress || {};
    const gold = root.gold || {};
    return {
      characters: root.characters,
      done: progress.completed,
      total: progress.total,
      soloDone: numberOrZero(soloProgress.completed),
      soloTotal: numberOrZero(soloProgress.total ?? root.solo),
      gold,
      goldTotal: numberOrZero(gold.total),
      goldEarnedUnbound: numberOrZero(gold.earnedUnbound),
      goldTotalUnbound: numberOrZero(gold.totalUnbound),
    };
  }

  function buildGlobalRollupLines(totalPages, globalTotals, lang) {
    if (totalPages <= 1) return [];
    const totals = normalizeGlobalRollup(globalTotals);
    const lines = [
      t("raid-status.embed.allAccounts", lang, {
        chars: totals.characters,
        done: totals.done,
        total: totals.total,
        soloDone: totals.soloDone,
        soloTotal: totals.soloTotal,
      }),
    ];

    if (totals.goldTotal > 0) {
      lines.push(t("raid-status.embed.goldRollup", lang, {
        earned: formatGold(totals.goldEarnedUnbound),
        total: formatGold(totals.goldTotalUnbound),
        boundTail: buildBoundGoldTail(totals.gold, lang),
      }));
    }
    return lines;
  }

  function buildRosterGoldLine(account, getRaidsFor, lang) {
    if (typeof summarizeAccountGold !== "function") return "";
    const accountGold = summarizeAccountGold(account, getRaidsFor);
    if (accountGold.total <= 0) return "";
    return t("raid-status.embed.rosterGold", lang, {
      earned: formatGold(accountGold.earnedUnbound),
      total: formatGold(accountGold.totalUnbound),
      boundTail: buildBoundGoldTail(accountGold, lang),
    });
  }

  function hasEligibleNonEarner(account, getRaidsFor) {
    return (account.characters || []).some(
      (character) => !character?.isGoldEarner && getRaidsFor(character).length > 0
    );
  }

  function buildAccountDescriptionLines({
    account,
    totalPages,
    globalTotals,
    getRaidsFor,
    userMeta,
    showGoldEarnerHint,
    lang,
  }) {
    const lines = buildGlobalRollupLines(totalPages, globalTotals, lang);
    const rosterGoldLine = buildRosterGoldLine(account, getRaidsFor, lang);
    const freshnessLine = buildAccountFreshnessLine(account, userMeta, lang);
    lines.push(...[
      rosterGoldLine,
      freshnessLine,
      showGoldEarnerHint && hasEligibleNonEarner(account, getRaidsFor)
        ? t("raid-status.embed.goldEarnerHint", lang)
        : "",
    ].filter(Boolean));
    return lines;
  }

  function resolveVisibleCharacters({
    characters,
    shouldDisplayCharacter,
    hideIneligibleChars,
    getRaidsFor,
  }) {
    const displayCharacters = typeof shouldDisplayCharacter === "function"
      ? characters.filter(shouldDisplayCharacter)
      : characters;
    return hideIneligibleChars
      ? displayCharacters.filter((character) => getRaidsFor(character).length > 0)
      : displayCharacters;
  }

  function appendOutcomeField(embed, outcomeLine) {
    if (!outcomeLine) return;
    embed.addFields({ name: "​", value: outcomeLine, inline: false });
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
    const {
      hideIneligibleChars = false,
      getProgressRaidsFor = getRaidsFor,
      shouldDisplayCharacter = null,
      showCharacterGold = true,
      showGoldEarnerHint = true,
      lang = "vi",
    } = options;
    const characters = Array.isArray(account.characters) ? account.characters : [];
    const accountProgress = summarizeAccountProgress(characters, getProgressRaidsFor);
    const title = buildAccountTitle(account, accountProgress, userMeta, lang);
    const descriptionLines = buildAccountDescriptionLines({
      account,
      totalPages,
      globalTotals,
      getRaidsFor,
      userMeta,
      showGoldEarnerHint,
      lang,
    });

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

    if (characters.length === 0) {
      embed.addFields({
        name: "​",
        value: t("raid-status.embed.noCharacters", lang),
        inline: false,
      });
      appendOutcomeField(embed, outcomeLine);
      return embed;
    }

    const visibleChars = resolveVisibleCharacters({
      characters,
      shouldDisplayCharacter,
      hideIneligibleChars,
      getRaidsFor,
    });

    if (visibleChars.length === 0) {
      if (hideIneligibleChars) {
        embed.addFields({
          name: "​",
          value: `${UI.icons.lock} ${t("raid-status.embed.allIneligible", lang)}`,
          inline: false,
        });
      }
      appendOutcomeField(embed, outcomeLine);
      return embed;
    }

    embed.addFields(
      ...pack2Columns(
        visibleChars.map((c) =>
          buildCharacterField(c, getRaidsFor, lang, {
            showGold: showCharacterGold,
          })
        )
      )
    );

    appendOutcomeField(embed, outcomeLine);
    return embed;
  }

  return {
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
  };
}

module.exports = { createRaidStatusView };
