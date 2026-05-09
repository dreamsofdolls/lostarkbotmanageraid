const { getClassEmoji } = require("../../models/Class");
const { pack2Columns, formatProgressTotals } = require("../../utils/raid/shared");

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
  function buildStatusFooterText(globalTotals, pageInfo = null) {
    const { completed = 0, partial = 0, total = 0 } = globalTotals?.progress || {};
    const pending = Math.max(0, total - completed - partial);
    // Shared formatter for the `🟢 N done · 🟡 N · ⚪ N` icon line so
    // /raid-status + /raid-check render with identical icon ordering /
    // spacing. Page indicator stays surface-specific (only multi-page
    // /raid-status appends it).
    let line = formatProgressTotals(
      { done: completed, partial, pending },
      UI
    );
    if (pageInfo && Number(pageInfo.totalPages) > 1) {
      line += ` · Page ${Number(pageInfo.pageIndex) + 1}/${Number(pageInfo.totalPages)}`;
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

  function buildCharacterField(character, getRaidsFor) {
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
      ? [`${UI.icons.lock} _Not eligible yet_`]
      : raids.map((raid) => formatRaidStatusLine(raid));

    const goldLine = buildCharacterGoldLine(character, raids);
    if (goldLine) lines.push(goldLine);

    return {
      name: fieldName,
      value: truncateText(lines.join("\n"), 1024),
      inline: true,
    };
  }

  function buildAccountFreshnessLine(account, userMeta) {
    const parts = [];
    const lastRefreshedAt = Number(account?.lastRefreshedAt) || 0;
    if (lastRefreshedAt > 0) {
      // Discord native timestamp `<t:UNIX:R>` ticks client-side - browser
      // refreshes the relative string every second without a server-side
      // re-render. Replaces the static `formatShortRelative()` snapshot
      // so the freshness line stays accurate even after the user has
      // been staring at the embed for a minute.
      const lastUpdatedTs = `<t:${Math.floor(lastRefreshedAt / 1000)}:R>`;
      const lastUpdated = `${UI.icons.roster} Last updated ${lastUpdatedTs}`;
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
        //
        // Wording is "Refresh ready <t:R>" instead of "Next refresh
        // <t:R>" so both tense forms read cleanly: future "Refresh ready
        // in 1h30m" + past "Refresh ready 16s ago" (= has been ready for
        // 16s). Discord's client-side ticker keeps counting past zero
        // into past tense once the embed has been on screen long enough,
        // so neutral wording avoids the awkward "Next sync 16 seconds
        // ago" the original Round-29 wording produced when an idle user
        // watched the embed past the manager 15s cooldown.
        const cooldownMs = refreshCooldownMs;
        const cursor =
          Number(account?.lastRefreshAttemptAt) ||
          Number(account?.lastRefreshedAt) ||
          0;
        const nextEligible = cursor + cooldownMs;
        const nextTs = `<t:${Math.floor(nextEligible / 1000)}:R>`;
        parts.push(`${lastUpdated} · ⏳ Refresh ready ${nextTs}`);
      } else {
        parts.push(`${lastUpdated} · ✅ Refresh ready`);
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
      const lastSync =
        lastSyncAt > 0
          ? `${UI.icons.reset} Last synced <t:${Math.floor(lastSyncAt / 1000)}:R>`
          : `${UI.icons.reset} Never synced`;
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
        // Same neutral-tense wording as the refresh branch above:
        // "Sync ready in 14s" (future) / "Sync ready 16s ago" (past =
        // has been ready 16s) both read cleanly while letting Discord's
        // <t:R> ticker keep counting in real time without flipping into
        // an awkward "Next sync ago" form.
        const nextEligible = lastAttempt + cooldownMs;
        const nextTs = `<t:${Math.floor(nextEligible / 1000)}:R>`;
        parts.push(`${lastSync} · ⏳ Sync ready ${nextTs}`);
      } else {
        parts.push(`${lastSync} · ✅ Sync ready`);
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
  // "tớ"/"Artist" framing instead of neutral status copy. Icons picked
  // for semantic clarity: ⏳ (in-progress) for timeout because the
  // gather is still running in background, ⚠️ for failed because the
  // gather actually rejected.
  function buildPiggybackOutcomeLine(piggybackOutcome) {
    if (!piggybackOutcome) return null;
    switch (piggybackOutcome.outcome) {
      case "applied": {
        const n = piggybackOutcome.newGatesApplied || 0;
        return `${UI.icons.reset} Artist vừa sync xong, có **${n}** gate mới luôn nha~`;
      }
      case "synced-no-new":
        return `${UI.icons.done} Artist đã sync rồi, hiện không có gate clear mới nha~`;
      case "timeout":
        return "⏳ Bible đang chậm tay, Artist vẫn đang lấy ngầm. Cậu mở lại sau ~10s là có data mới nha~";
      case "failed":
        return `${UI.icons.warn} Bible đang dở chứng, Artist tạm xem cache. Cậu thử lại sau vài phút giúp tớ nhé~`;
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
    const { hideIneligibleChars = false } = options;
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
    // Page counter lives in the footer (next to done/partial/pending
    // counts) per /raid-check parity; title stays as just icon + account
    // so the identity of the rendered roster is the sole headline.
    const headerIcon = isShared ? "👥" : pickRosterHeaderIcon(userMeta?.discordId);
    // Inline `· 📝 Auto-sync OFF` badge when the rendered subject hasn't
    // opted into /raid-auto-manage. Useful in 2 contexts that share this
    // builder: (1) /raid-status caller seeing their own roster with a
    // light nudge to opt in; (2) /raid-check leader scanning
    // across guild members, immediately spotting who requires manual
    // Edit. Silent when opted-in to keep the title lean for the common
    // case. Strict `=== false` so a missing/unknown flag (legacy doc)
    // doesn't false-positive into showing OFF. Skipped on shared pages
    // because the auto-sync flag belongs to owner A's settings, not B's.
    const autoSyncBadge =
      !isShared && userMeta?.autoManageEnabled === false
        ? " · 📝 Auto-sync OFF"
        : "";
    const sharedBadge = isShared
      ? ` · 👥 Shared by ${sharedFrom.ownerLabel || "(unknown)"} (${sharedFrom.accessLevel || "edit"})`
      : "";
    const title = `${titleIcon} ${headerIcon} ${account.accountName}${autoSyncBadge}${sharedBadge}`;

    // Description used to lead with a per-account "N chars · X/Y raids
    // done · K in progress" line, but those counts are now carried by
    // the footer legend itself (X done · Y partial · Z pending) - keeping
    // both would duplicate the same information in two places. The
    // cross-account rollup stays because it's a different scope
    // (subject-wide, not per-account) and helps when flipping pages.
    const descriptionLines = [];
    if (totalPages > 1) {
      // Cross-account rollup. The gold tail is the GRAND total across
      // every roster the user has - distinct from the per-account
      // "Earned this week" line directly below (which is just the
      // current page's account). Round-32 briefly removed the tail
      // because a single-earner-account user saw identical numbers in
      // both places, but with multiple accounts marked the cross-
      // account figure is a separate signal worth keeping.
      // Suppressed when total <= 0 so an all-non-earner roster doesn't
      // render a misleading "💰 0G / 0G" segment.
      const globalGoldTotal = Number(globalTotals?.gold?.total) || 0;
      const globalGoldEarned = Number(globalTotals?.gold?.earned) || 0;
      const globalGoldTail = globalGoldTotal > 0
        ? ` · 💰 **${formatGold(globalGoldEarned)} / ${formatGold(globalGoldTotal)}**`
        : "";
      descriptionLines.push(
        `🌐 All accounts: **${globalTotals.characters}** chars · **${globalTotals.progress.completed}/${globalTotals.progress.total}** raids done${globalGoldTail}`
      );
    }
    // Per-account gold rollup. Always emitted on accounts with at least
    // one gold-earner, even on a single-page roster (we still want the
    // "this week's haul" headline). Suppressed when no gold-earner is
    // configured for the account at all - same honesty rule as the
    // cross-account tail above.
    if (typeof summarizeAccountGold === "function") {
      const accountGold = summarizeAccountGold(account, getRaidsFor);
      if (accountGold.total > 0) {
        descriptionLines.push(
          `💰 Earned this week: **${formatGold(accountGold.earned)}** / **${formatGold(accountGold.total)}**`
        );
      }
    }
    const freshnessLine = buildAccountFreshnessLine(account, userMeta);
    if (freshnessLine) descriptionLines.push(freshnessLine);

    // Discoverability hint for /raid-gold-earner. Shown ONLY when the
    // account has at least one eligible char (>= 1 raid unlocked at
    // current iLvl) that isn't yet a gold-earner. Suppressed when:
    //   - every eligible char is already an earner (cap-reached state
    //     or all-gold-earner state - no decision left)
    //   - account has no eligible chars at all (early-roster / sub-1700)
    //   - account is empty
    // Below-iLvl chars are excluded from the count because they can't
    // earn raid gold this week regardless of the flag, so they don't
    // signal "decision pending" - matches Traine's "5 chars all above
    // 1700 + all marked → hint disappears" rule.
    const eligibleNonEarnerCount = (account.characters || []).filter(
      (c) => !c?.isGoldEarner && getRaidsFor(c).length > 0
    ).length;
    if (eligibleNonEarnerCount > 0) {
      descriptionLines.push(
        "_💰 Mark gold-earner bằng `/raid-gold-earner roster:<tên>` (cap 6 / account / tuần)._"
      );
    }

    // Bible-piggyback outcome line (computed here so the early-return
    // paths below can also surface it, but rendered as a FINAL FIELD
    // below the char fields - see the addFields call near the end of
    // this function). Placement at the bottom (just before the
    // done/partial/pending legend in the footer) keeps the freshness
    // info compact at the top while leaving room for the outcome to
    // sit next to the totals it explains.
    //
    // Skip the "not-applicable" / "synced-no-new" / "cooldown" cases:
    // those add noise without information - the freshness line above
    // already tells the user when bible was last successfully synced
    // + countdown to the next free attempt.
    const outcomeLine = buildPiggybackOutcomeLine(userMeta?.piggybackOutcome);

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(accountProgress.color)
      .setFooter({
        text: buildStatusFooterText(globalTotals, { pageIndex, totalPages }),
      })
      .setTimestamp();

    if (descriptionLines.length > 0) {
      embed.setDescription(descriptionLines.join("\n"));
    }

    // Render outcome as a FINAL field just before the footer legend.
    // Used by every return path so the user gets the same "what just
    // happened on bible sync" info regardless of whether the roster is
    // full / empty / all-ineligible.
    const appendOutcomeField = () => {
      if (outcomeLine) {
        embed.addFields({ name: "\u200B", value: outcomeLine, inline: false });
      }
    };

    if (characters.length === 0) {
      embed.addFields({ name: "\u200B", value: "_No characters saved._", inline: false });
      appendOutcomeField();
      return embed;
    }

    // When `hideIneligibleChars` is on (caller has an active raid filter),
    // drop chars whose getRaidsFor returns empty - a locked "🔒 Not
    // eligible yet" card for every char below the iLvl gate is pure
    // noise when the caller just wants to see who CAN do the picked raid.
    // Filter state lives at the call site; passing the flag lets the
    // builder render an "all chars ineligible" notice when the roster
    // has zero relevant chars, vs "no chars saved" (empty account) vs
    // the normal fields path.
    const visibleChars = hideIneligibleChars
      ? characters.filter((c) => getRaidsFor(c).length > 0)
      : characters;

    if (visibleChars.length === 0 && hideIneligibleChars) {
      embed.addFields({
        name: "​",
        value: `${UI.icons.lock} _Không có character nào eligible cho raid này trong roster._`,
        inline: false,
      });
      appendOutcomeField();
      return embed;
    }

    embed.addFields(
      ...pack2Columns(visibleChars.map((c) => buildCharacterField(c, getRaidsFor)))
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
