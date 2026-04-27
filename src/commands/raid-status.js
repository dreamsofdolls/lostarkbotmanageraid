const { isSupportClass, getClassEmoji } = require("../data/Class");
const {
  buildNoticeEmbed,
  pack2Columns,
  formatProgressTotals,
  normalizeName,
} = require("../raid/shared");
const { buildAccountTaskFields } = require("../raid/task-view");

const STATUS_PAGINATION_SESSION_MS = 5 * 60 * 1000;
const STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS = 2500;

function createRaidStatusCommand(deps) {
  const {
    EmbedBuilder,
    ComponentType,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    getCharacterName,
    truncateText,
    formatShortRelative,
    formatNextCooldownRemaining,
    waitWithBudget,
    summarizeRaidProgress,
    formatRaidStatusLine,
    getStatusRaidsForCharacter,
    buildPaginationRow,
    collectStaleAccountRefreshes,
    applyStaleAccountRefreshes,
    formatRosterRefreshCooldownRemaining,
    ROSTER_REFRESH_COOLDOWN_MS,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    applyAutoManageCollectedForStatus,
    stampAutoManageAttempt,
    weekResetStartMs,
    AUTO_MANAGE_SYNC_COOLDOWN_MS,
    getAutoManageCooldownMs,
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
    const fieldValue = raids.length === 0
      ? `${UI.icons.lock} _Not eligible yet_`
      : raids.map((raid) => formatRaidStatusLine(raid)).join("\n");

    return {
      name: fieldName,
      value: truncateText(fieldValue, 1024),
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
      const remain = formatRosterRefreshCooldownRemaining(account);
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
        const cooldownMs = ROSTER_REFRESH_COOLDOWN_MS;
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

    if (userMeta?.autoManageEnabled) {
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

    // Page counter lives in the footer (next to done/partial/pending
    // counts) per /raid-check parity; title stays as just icon + account
    // so the identity of the rendered roster is the sole headline.
    const headerIcon = pickRosterHeaderIcon(userMeta?.discordId);
    // Inline `· 📝 Auto-sync OFF` badge when the rendered subject hasn't
    // opted into /raid-auto-manage. Useful in 2 contexts that share this
    // builder: (1) /raid-status caller seeing their own roster with a
    // light nudge to opt in; (2) /raid-check raid:all leader scanning
    // across guild members, immediately spotting who requires manual
    // Edit. Silent when opted-in to keep the title lean for the common
    // case. Strict `=== false` so a missing/unknown flag (legacy doc)
    // doesn't false-positive into showing OFF.
    const autoSyncBadge = userMeta?.autoManageEnabled === false ? " · 📝 Auto-sync OFF" : "";
    const title = `${titleIcon} ${headerIcon} ${account.accountName}${autoSyncBadge}`;

    // Description used to lead with a per-account "N chars · X/Y raids
    // done · K in progress" line, but those counts are now carried by
    // the footer legend itself (X done · Y partial · Z pending) - keeping
    // both would duplicate the same information in two places. The
    // cross-account rollup stays because it's a different scope
    // (subject-wide, not per-account) and helps when flipping pages.
    const descriptionLines = [];
    if (totalPages > 1) {
      descriptionLines.push(
        `🌐 All accounts: **${globalTotals.characters}** chars · **${globalTotals.progress.completed}/${globalTotals.progress.total}** raids done`
      );
    }
    const freshnessLine = buildAccountFreshnessLine(account, userMeta);
    if (freshnessLine) descriptionLines.push(freshnessLine);

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

  async function handleStatusCommand(interaction) {
    const discordId = interaction.user.id;
    const seedDoc = await User.findOne({ discordId });
    if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Cậu chưa có roster nào",
            description: "Artist không thấy roster nào của cậu trong DB. Dùng `/add-roster` để add roster đầu tiên rồi mới `/raid-status` xem progress được nha~",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();

    let userDoc = null;
    let autoManageGuard = null;
    let autoManageReleaseInBackground = false;

    // Piggyback outcome tracker so we can surface "what just happened on
    // this open" in the embed. /raid-status is the only sync entry point
    // for regular users (they cannot use /raid-check Sync); without an
    // outcome surface the user has no way to tell whether the data they
    // see reflects a fresh bible pull, a silently-timed-out attempt, or
    // a cached read because they were within the 10m cooldown.
    //
    // outcome values:
    //   - "not-applicable": user not opted-in / no roster, no piggyback
    //   - "cooldown": slot guard rejected (within 10m of last attempt)
    //   - "failed": gather promise rejected (bible API issue)
    //   - "timeout": gather exceeded the 2.5s budget, running in bg
    //   - "synced-no-new": gather + apply succeeded but no new gates
    //   - "applied": gather + apply succeeded, N new gates applied
    const piggybackOutcome = {
      outcome: "not-applicable",
      newGatesApplied: 0,
    };

    try {
      ensureFreshWeek(seedDoc);

      let autoManagePromise = Promise.resolve(null);
      let autoManageWeekResetStart = null;
      const hasRoster = Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;
      if (seedDoc.autoManageEnabled && hasRoster) {
        autoManageGuard = await acquireAutoManageSyncSlot(discordId);
        if (autoManageGuard.acquired) {
          autoManageWeekResetStart = weekResetStartMs();
          autoManagePromise = gatherAutoManageLogsForUserDoc(
            seedDoc,
            autoManageWeekResetStart
          ).catch((err) => {
            console.warn(
              "[raid-status] auto-manage piggyback gather failed:",
              err?.message || err
            );
            return null;
          });
        } else {
          piggybackOutcome.outcome = "cooldown";
        }
      }

      const [refreshCollected, autoManageBudgetResult] = await Promise.all([
        collectStaleAccountRefreshes(seedDoc),
        autoManageGuard?.acquired
          ? waitWithBudget(autoManagePromise, STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS)
          : Promise.resolve({ timedOut: false, value: null }),
      ]);
      let autoManageCollected = autoManageBudgetResult.value;
      const autoManageBibleHit = autoManageGuard?.acquired === true;
      const autoManageTimedOut = autoManageGuard?.acquired && autoManageBudgetResult.timedOut;
      // Gather rejected: budget didn't time out, slot was acquired, but
      // the value is null (the .catch in the gather chain converts a
      // throw into null). Distinct from timeout because the bg task is
      // already settled - nothing keeps running.
      const autoManageGatherFailed =
        autoManageGuard?.acquired &&
        !autoManageBudgetResult.timedOut &&
        autoManageBudgetResult.value === null;
      if (autoManageTimedOut) piggybackOutcome.outcome = "timeout";
      else if (autoManageGatherFailed) piggybackOutcome.outcome = "failed";

      if (autoManageTimedOut) {
        autoManageCollected = null;
        autoManageReleaseInBackground = true;
        autoManagePromise
          .then((backgroundCollected) =>
            applyAutoManageCollectedForStatus(
              discordId,
              autoManageWeekResetStart,
              backgroundCollected,
              "background"
            )
          )
          .catch(async (err) => {
            console.warn(
              "[raid-status] background auto-manage apply failed:",
              err?.message || err
            );
            await stampAutoManageAttempt(discordId);
          })
          .finally(() => releaseAutoManageSyncSlot(discordId));
        console.log(
          `[raid-status] auto-manage exceeded ${STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS}ms budget for user=${discordId}; rendering cached data and continuing in background`
        );
      }

      userDoc = await saveWithRetry(async () => {
        const doc = await User.findOne({ discordId });
        if (!doc) return null;

        const didFreshenWeek = ensureFreshWeek(doc);
        const didRefresh = applyStaleAccountRefreshes(doc, refreshCollected);

        let didAutoManage = false;
        if (autoManageCollected && doc.autoManageEnabled) {
          const autoReport = applyAutoManageCollected(
            doc,
            autoManageWeekResetStart,
            autoManageCollected
          );
          const now = Date.now();
          doc.lastAutoManageAttemptAt = now;
          if (autoReport.perChar.some((c) => !c.error)) {
            doc.lastAutoManageSyncAt = now;
          }
          // Count newly-applied gates so the surface line can show
          // "synced N new gates" instead of just "synced". Sums
          // perChar[].applied[].length across every char in the report.
          const newGates = autoReport.perChar.reduce(
            (sum, entry) =>
              sum + (Array.isArray(entry.applied) ? entry.applied.length : 0),
            0
          );
          piggybackOutcome.newGatesApplied = newGates;
          piggybackOutcome.outcome = newGates > 0 ? "applied" : "synced-no-new";
          didAutoManage = true;
        } else if (autoManageBibleHit) {
          doc.lastAutoManageAttemptAt = Date.now();
          didAutoManage = true;
        }

        if (didFreshenWeek || didRefresh || didAutoManage) await doc.save();
        return doc.toObject();
      });
    } catch (err) {
      console.error("[raid-status] lazy refresh failed:", err?.message || err);
      if (autoManageGuard?.acquired) {
        await stampAutoManageAttempt(discordId);
      }
      userDoc = await User.findOne({ discordId }).lean();
    } finally {
      if (autoManageGuard?.acquired && !autoManageReleaseInBackground) {
        releaseAutoManageSyncSlot(discordId);
      }
    }

    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await interaction.editReply({
        content: null,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Cậu chưa có roster nào",
            description: "Artist không thấy roster nào của cậu trong DB. Dùng `/add-roster` để add roster đầu tiên rồi mới `/raid-status` xem progress được nha~",
          }),
        ],
      });
      return;
    }

    const raidsCache = new Map();
    const baseGetRaidsFor = (character) => {
      let result = raidsCache.get(character);
      if (!result) {
        result = getStatusRaidsForCharacter(character);
        raidsCache.set(character, result);
      }
      return result;
    };

    let accounts = userDoc.accounts;
    const totalCharacters = accounts.reduce(
      (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
      0
    );

    // Extracted so the Sync button handler can reload userDoc + outcome
    // and rebuild this object without duplicating the field shape.
    const buildStatusUserMeta = (doc, outcome) => ({
      discordId: doc.discordId,
      autoManageEnabled: !!doc.autoManageEnabled,
      lastAutoManageSyncAt: Number(doc.lastAutoManageSyncAt) || 0,
      lastAutoManageAttemptAt: Number(doc.lastAutoManageAttemptAt) || 0,
      piggybackOutcome: outcome,
    });
    let statusUserMeta = buildStatusUserMeta(userDoc, piggybackOutcome);

    // Raid-filter aggregate for the caller's own roster. Parallel to the
    // all-mode dropdown in /raid-check raid:all, but counts here are
    // self-scoped (chars across caller's accounts where the raid isn't
    // fully cleared yet). Computed once at init with the unfiltered
    // getRaidsFor so toggling filters later doesn't rewrite the labels
    // underneath the user's hand - labels stay as a stable "my backlog
    // per raid" reference. Sorted pending desc so the heaviest backlog
    // surfaces first.
    // Per-raid entries also track {supports, dps} so the dropdown label
    // can render "Aegir Hard (3 pending · 1🛡️ 2⚔️)" - lets the caller see
    // at a glance whether a raid's backlog is composition-blocking (no
    // supports left) or just queue depth. Hard-support classes are Bard
    // / Paladin / Artist / Valkyrie; everyone else counts as DPS.
    const FILTER_ALL_RAIDS = "__all_raids__";
    let raidAggregate = new Map();
    for (const account of accounts) {
      for (const ch of account.characters || []) {
        const charIsSupport = isSupportClass(ch?.class);
        for (const raid of baseGetRaidsFor(ch)) {
          const key = `${raid.raidKey}:${raid.modeKey}`;
          let entry = raidAggregate.get(key);
          if (!entry) {
            entry = {
              key,
              label: raid.raidName,
              raidKey: raid.raidKey,
              modeKey: raid.modeKey,
              pending: 0,
              supports: 0,
              dps: 0,
            };
            raidAggregate.set(key, entry);
          }
          if (!raid.isCompleted) {
            entry.pending += 1;
            if (charIsSupport) entry.supports += 1;
            else entry.dps += 1;
          }
        }
      }
    }
    let raidDropdownEntries = [...raidAggregate.values()].sort(
      (a, b) => b.pending - a.pending || a.label.localeCompare(b.label)
    );
    let totalRaidPending = raidDropdownEntries.reduce(
      (sum, r) => sum + r.pending,
      0
    );

    // Repopulates raidAggregate / raidDropdownEntries / totalRaidPending
    // from the current `accounts` array. Called after the Sync button
    // reloads userDoc so the per-raid dropdown counts reflect any newly-
    // applied gates.
    const recomputeRaidAggregate = () => {
      raidAggregate = new Map();
      for (const account of accounts) {
        for (const ch of account.characters || []) {
          const charIsSupport = isSupportClass(ch?.class);
          for (const raid of baseGetRaidsFor(ch)) {
            const key = `${raid.raidKey}:${raid.modeKey}`;
            let entry = raidAggregate.get(key);
            if (!entry) {
              entry = {
                key,
                label: raid.raidName,
                raidKey: raid.raidKey,
                modeKey: raid.modeKey,
                pending: 0,
                supports: 0,
                dps: 0,
              };
              raidAggregate.set(key, entry);
            }
            if (!raid.isCompleted) {
              entry.pending += 1;
              if (charIsSupport) entry.supports += 1;
              else entry.dps += 1;
            }
          }
        }
      }
      raidDropdownEntries = [...raidAggregate.values()].sort(
        (a, b) => b.pending - a.pending || a.label.localeCompare(b.label)
      );
      totalRaidPending = raidDropdownEntries.reduce(
        (sum, r) => sum + r.pending,
        0
      );
    };

    let currentPage = 0;
    let filterRaidId = null;
    // View toggle: "raid" = default progress page, "task" = per-character
    // side-task list (registered via /raid-task). Dropdown swaps the embed
    // body + the third action row but keeps pagination semantics so the
    // user stays on the same account when toggling views.
    let currentView = "raid";
    // Char filter for Task view's toggle dropdown. Stored per-page (Map
    // keyed by currentPage) so navigating across accounts doesn't lose
    // the user's per-account char focus. null = "auto-pick first char
    // with tasks" so the toggle dropdown is always populated when there's
    // at least one task on the account. Codex round 28 finding #2:
    // without scoping, accounts with > 25 total tasks (4+ chars × cap 8)
    // would silently drop tail entries from the toggle dropdown.
    const taskCharFilterByPage = new Map();

    // Build the current page's embed given the active (page, raid-filter,
    // view) triple. Rebuilt on every state change instead of pre-baking a
    // pages[] array because any filter pick invalidates every pre-built
    // embed - /raid-status's roster count is small enough (<10 accounts
    // typical) that one buildAccountPageEmbed per interaction is zero-cost.
    //
    // When currentView === "task", dispatch to buildTaskViewEmbed (defined
    // further below) which renders the per-character side-task list for
    // the current page's account. The raid filter doesn't apply in task
    // view but its state is preserved so toggling back keeps the user's
    // raid filter pick.
    const buildCurrentEmbed = () => {
      if (currentView === "task") {
        return buildTaskViewEmbed(accounts[currentPage]);
      }
      const getRaidsFor = filterRaidId
        ? (ch) =>
            baseGetRaidsFor(ch).filter(
              (r) => `${r.raidKey}:${r.modeKey}` === filterRaidId
            )
        : baseGetRaidsFor;

      // Recompute globalTotals against the filtered view so the footer
      // (and the cross-account rollup line, when >1 account) reflect
      // only the picked raid's done/partial/pending when a filter is
      // active. Characters count stays at totalCharacters regardless -
      // "12 chars in roster" is a static fact of the roster, not
      // something the filter narrows.
      const filteredEntries = [];
      for (const a of accounts) {
        for (const c of a.characters || []) {
          filteredEntries.push(...getRaidsFor(c));
        }
      }
      const filteredTotals = {
        characters: totalCharacters,
        progress: summarizeRaidProgress(filteredEntries),
      };

      return buildAccountPageEmbed(
        accounts[currentPage],
        currentPage,
        accounts.length,
        filteredTotals,
        getRaidsFor,
        statusUserMeta,
        { hideIneligibleChars: !!filterRaidId }
      );
    };

    const buildRaidFilterRow = (disabled) => {
      const options = [
        {
          label: truncateText(
            `All raids (${totalRaidPending === 0 ? "DONE" : `${totalRaidPending} total pending`})`,
            100
          ),
          value: FILTER_ALL_RAIDS,
          emoji: "🌐",
          default: filterRaidId === null,
        },
      ];
      for (const r of raidDropdownEntries.slice(0, 24)) {
        // Caller has cleared every eligible char of this raid -> show
        // "DONE" instead of "0 pending · 0🛡️ 0⚔️". Cleaner scan when most
        // of the roster is up to date but a couple raids still drag.
        const suffix = r.pending === 0
          ? "DONE"
          : `${r.pending} pending · ${r.supports}🛡️ ${r.dps}⚔️`;
        options.push({
          label: truncateText(
            `${r.label} (${suffix})`,
            100
          ),
          value: r.key,
          emoji: "⚔️",
          default: filterRaidId === r.key,
        });
      }
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-filter:raid")
          .setPlaceholder("Filter by raid / Lọc theo raid...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    // Sync button: shown only when caller is opted-in to /raid-auto-manage.
    // Click triggers the same gather + apply pipeline as the open-time
    // piggyback but on demand; the embed updates in place so the user
    // doesn't have to re-issue /raid-status to see fresh data. Cooldown
    // is enforced by acquireAutoManageSyncSlot - if the slot rejects,
    // the outcome line at the bottom of the embed surfaces "cooldown"
    // (silent skip in the current outcome-line policy) - here we instead
    // surface the remaining cooldown via an ephemeral followup so the
    // click feedback is explicit.
    // Resolve the per-user cooldown ms via the manager allowlist (15s
    // for Manager, 10m for everyone else). Falls back to the legacy
    // module constant if the helper isn't injected.
    const resolveCooldownMs = () =>
      typeof getAutoManageCooldownMs === "function"
        ? getAutoManageCooldownMs(discordId)
        : AUTO_MANAGE_SYNC_COOLDOWN_MS;

    // Compose the Sync button label dynamically: when the user is
    // currently within the per-user cooldown window, embed the
    // remaining wait directly in the label so they can see "how
    // long until I can re-sync" at a glance without clicking. When
    // the cooldown has elapsed (or never started), label collapses
    // to the cleaner "Sync ngay" call-to-action.
    const computeSyncLabel = () => {
      const remain = formatNextCooldownRemaining(
        Number(statusUserMeta.lastAutoManageAttemptAt) || 0,
        resolveCooldownMs()
      );
      return remain ? `Sync (${remain})` : "Sync ngay";
    };

    const buildSyncButton = (disabled) =>
      new ButtonBuilder()
        .setCustomId("status:sync")
        .setLabel(computeSyncLabel())
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled);

    const buildSyncRow = (disabled) =>
      new ActionRowBuilder().addComponents(buildSyncButton(disabled));

    // Parse a Discord custom-emoji string `<:name:id>` (or `<a:name:id>`
    // for animated) into an object the StringSelectMenu option's `emoji`
    // property accepts. Returns null on miss so callers can `|| undefined`
    // to skip the emoji slot. StringSelectMenu does NOT render custom
    // emoji embedded in the label string - it shows the raw `<:name:id>`
    // text - so the emoji has to ride the structured field instead.
    const parseCustomEmoji = (raw) => {
      if (typeof raw !== "string" || raw.length === 0) return null;
      const match = raw.match(/^<(a?):([^:]+):(\d+)>$/);
      if (!match) return null;
      return {
        animated: match[1] === "a",
        name: match[2],
        id: match[3],
      };
    };

    // Build the Task-view embed for the current page's account. Body
    // (per-char fields + 2-column ZWS-spacer packing + totals math) is
    // delegated to the shared `buildAccountTaskFields` helper so the
    // /raid-check raid:all Manager Task view renders the same look
    // without duplicating ~80 LOC of layout code. This wrapper owns
    // the surface-specific bits: title, description, the "🌟 sắp có"
    // placeholder, and the page-indicator footer.
    const buildTaskViewEmbed = (account) => {
      const accountName = String(account?.accountName || "(unnamed roster)");
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`📝 Side tasks · ${accountName}`);

      const { fields, totals } = buildAccountTaskFields(account, {
        UI,
        getClassEmoji,
        truncateText,
      });

      if (totals.charsWithTasks === 0) {
        embed.setDescription(
          [
            "Account này chưa có side task nào nha.",
            "",
            "**Cách thêm:** `/raid-task add character:<char> name:<tên> reset:<daily|weekly>`",
            "**Cap:** 3 daily + 5 weekly mỗi character.",
            "**Auto-reset:** Daily 17:00 VN · Weekly 17:00 VN thứ 4.",
          ].join("\n")
        );
        return embed;
      }

      // Reuse the same freshness/sync lines the Raid view builds via
      // buildAccountPageEmbed. Two reasons:
      //   1. Parity: users want to know "when was this last refreshed +
      //      next refresh ready" regardless of which view they're on.
      //   2. Layout: those lines are this embed's longest content
      //      (`Last updated <t:R> · ⏳ Refresh ready <t:R>` ~ 55 chars
      //      after Discord's relative-timestamp expansion). Discord
      //      auto-fits inline-field column width to the longest line in
      //      the embed body, so without these lines the column shrinks
      //      and long char headers like `Crimsonjudgment · 1700` wrap
      //      onto a second line. Adding them widens the columns to match
      //      the Raid view exactly.
      const descriptionLines = [
        "Bấm dropdown bên dưới để toggle complete cho từng task.",
        `Auto-reset: Daily 17:00 VN ${UI.icons.reset} Weekly 17:00 VN thứ 4.`,
      ];
      const freshnessLine = buildAccountFreshnessLine(account, statusUserMeta);
      if (freshnessLine) descriptionLines.push(freshnessLine);
      embed.setDescription(descriptionLines.join("\n"));

      embed.addFields(...fields);

      // Placeholder field for the upcoming "shared task per roster"
      // feature - one task definition that applies to every char in
      // the account (vs the current per-char model). Sits between the
      // char cards and the footer legend so users see the roadmap at
      // a glance. Artist-voice copy keeps the persona consistent.
      // Remove this addFields() block when the real feature lands.
      embed.addFields({
        name: "🌟 Task chung của roster (sắp có)",
        value: [
          "Tớ ngóng feature này dữ lắm~ Sắp tới mỗi roster sẽ có thêm 1 list task **áp cho mọi char trong account** (kiểu chore chung Owner đăng ký, không phải gõ `/raid-task add` cho từng con).",
          "Trong lúc chờ, cậu cứ dùng `action:all` ở `/raid-task add` để bulk add tạm cho mọi char nha~",
        ].join("\n"),
        inline: false,
      });

      const footerParts = [];
      if (totals.daily > 0) {
        footerParts.push(`${UI.icons.done} ${totals.dailyDone}/${totals.daily} daily`);
      }
      if (totals.weekly > 0) {
        footerParts.push(`${UI.icons.done} ${totals.weeklyDone}/${totals.weekly} weekly`);
      }
      if (accounts.length > 1) {
        footerParts.push(`Page ${currentPage + 1}/${accounts.length}`);
      }
      if (footerParts.length > 0) {
        embed.setFooter({ text: footerParts.join(" · ") });
      }
      return embed;
    };

    const buildViewToggleRow = (disabled) => {
      const options = [
        {
          label: "Tiến độ raid",
          description: "Xem progress raid đã/chưa clear theo từng character",
          value: "raid",
          emoji: "📋",
          default: currentView === "raid",
        },
        {
          label: "Side tasks",
          description: "Xem + toggle daily/weekly task tự đăng ký",
          value: "task",
          emoji: "📝",
          default: currentView === "task",
        },
      ];
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-view:toggle")
          .setPlaceholder("Chọn view...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    // List the chars in the current account that have at least one
    // side task, in display order. Driver for both the char-filter
    // dropdown and the resolveTaskCharFilter() default-picker.
    const charsWithTasksOnPage = () => {
      const account = accounts[currentPage];
      const characters = Array.isArray(account?.characters)
        ? account.characters
        : [];
      return characters.filter(
        (c) => Array.isArray(c?.sideTasks) && c.sideTasks.length > 0
      );
    };

    // Sentinel value for the char-filter "All characters" mode - sits at
    // the top of the dropdown so the user can flip the same task across
    // every char in one click (use case: just finished Paradise on 6
    // alts, don't want to toggle 6 times). Pick anything that can't be
    // a Discord-allowed char name to keep the namespace collision-free.
    const ALL_CHARS_SENTINEL = "__ALL_CHARS__";

    // Resolve the effective char filter for the current page. Explicit
    // user pick wins; otherwise auto-pick the first char with tasks so
    // the toggle dropdown always has actionable items when at least one
    // task exists. Returns null when the page has zero tasks. Returns
    // ALL_CHARS_SENTINEL when the user explicitly picked the bulk mode.
    const resolveTaskCharFilter = () => {
      const explicit = taskCharFilterByPage.get(currentPage);
      const candidates = charsWithTasksOnPage();
      if (candidates.length === 0) return null;
      if (explicit === ALL_CHARS_SENTINEL) return ALL_CHARS_SENTINEL;
      if (explicit) {
        const stillExists = candidates.find(
          (c) =>
            getCharacterName(c).trim().toLowerCase() ===
            explicit.trim().toLowerCase()
        );
        if (stillExists) return getCharacterName(stillExists);
      }
      return getCharacterName(candidates[0]);
    };

    // Aggregate every (name, reset) task across the current page's
    // chars-with-tasks. Each entry rolls up:
    //   - chars that own this task ID-set
    //   - count completed across those chars
    // Used by the all-mode toggle dropdown to render `(X/N done)` and
    // to flip the bulk state in a single Mongo write.
    const aggregateTasksOnPage = () => {
      const candidates = charsWithTasksOnPage();
      const byKey = new Map();
      for (const character of candidates) {
        const charName = getCharacterName(character);
        const sideTasks = Array.isArray(character.sideTasks)
          ? character.sideTasks
          : [];
        for (const task of sideTasks) {
          if (!task?.name) continue;
          const key = `${task.name.trim().toLowerCase()}::${task.reset}`;
          let entry = byKey.get(key);
          if (!entry) {
            entry = {
              name: task.name,
              reset: task.reset,
              owners: [],
              doneCount: 0,
            };
            byKey.set(key, entry);
          }
          entry.owners.push({
            charName,
            taskId: task.taskId,
            completed: !!task.completed,
          });
          if (task.completed) entry.doneCount += 1;
        }
      }
      return [...byKey.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.reset.localeCompare(b.reset)
      );
    };

    // Char-filter dropdown: lists every char on the current page that
    // has at least one side task. User pick scopes the toggle dropdown
    // to that char only - because per-char cap is 8, the toggle
    // dropdown after filter is guaranteed to fit Discord's 25-option
    // StringSelect cap. Hidden when the page has no tasks (toggle row
    // would be a disabled placeholder anyway).
    const buildTaskCharFilterRow = (disabled) => {
      const candidates = charsWithTasksOnPage();
      if (candidates.length === 0) return null;
      const activeName = resolveTaskCharFilter();
      const options = [];
      // Bulk-mode entry first when the page has > 1 char with tasks -
      // single-char accounts don't need the bulk option (it would just
      // duplicate the per-char view). 24 char options + 1 bulk = 25 cap.
      if (candidates.length > 1) {
        const totalTaskCount = candidates.reduce(
          (sum, c) =>
            sum + (Array.isArray(c.sideTasks) ? c.sideTasks.length : 0),
          0
        );
        const totalDone = candidates.reduce(
          (sum, c) =>
            sum +
            (Array.isArray(c.sideTasks)
              ? c.sideTasks.filter((t) => t?.completed).length
              : 0),
          0
        );
        options.push({
          label: truncateText(
            `🌐 Tất cả character · ${totalDone}/${totalTaskCount}`,
            100
          ),
          value: ALL_CHARS_SENTINEL,
          description: "Bulk toggle 1 task cho mọi char cùng có nó",
          default: activeName === ALL_CHARS_SENTINEL,
        });
      }
      const charSlots = candidates.length > 1 ? 24 : 25;
      candidates.slice(0, charSlots).forEach((character) => {
        const name = getCharacterName(character);
        const itemLevel = Number(character.itemLevel) || 0;
        const taskCount = Array.isArray(character.sideTasks)
          ? character.sideTasks.length
          : 0;
        const doneCount = Array.isArray(character.sideTasks)
          ? character.sideTasks.filter((t) => t?.completed).length
          : 0;
        const label = truncateText(
          `${name} · ${itemLevel} · ${doneCount}/${taskCount}`,
          100
        );
        const classEmojiObj = parseCustomEmoji(getClassEmoji(character.class));
        const option = {
          label,
          value: name.slice(0, 100),
          default:
            !!activeName &&
            name.trim().toLowerCase() === activeName.trim().toLowerCase(),
        };
        // StringSelectMenu options accept custom emoji ONLY via the
        // structured `emoji` field, never inline in `label` text -
        // embedding `<:name:id>` in the label renders as raw markup
        // (Discord regression Trainee caught on the live deploy).
        if (classEmojiObj) option.emoji = classEmojiObj;
        options.push(option);
      });
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-task:char-filter")
          .setPlaceholder("Chọn character để toggle task...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    // Toggle dropdown for Task view. After the Codex-round-28 fix this
    // is scoped to ONE character at a time (selected via the char-filter
    // dropdown above). With per-char cap 8 the result always fits the
    // 25-option Discord StringSelect cap. Value shape:
    // `<charName>::<taskId>` so the collector can resolve back to the
    // character + task pair without a second lookup. Char names never
    // contain `::` so the separator is collision-safe.
    const buildTaskToggleRow = (disabled) => {
      const activeName = resolveTaskCharFilter();
      if (!activeName) {
        return new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("status-task:toggle")
            .setPlaceholder("Chưa có task nào - dùng /raid-task add để thêm")
            .setDisabled(true)
            .addOptions([{ label: "(empty)", value: "noop" }])
        );
      }
      // Bulk mode: dropdown lists every (name, reset) task aggregated
      // across all chars on the page. Picking one toggles the same task
      // ID on every owner-char in a single Mongo write. State icon
      // reflects aggregate completion: 🟢 when every owner-char has it
      // done, ⚪ otherwise. Clicking when 🟢 marks all as undone, when
      // ⚪ marks all as done (favors completion since "I just finished"
      // is the typical trigger).
      if (activeName === ALL_CHARS_SENTINEL) {
        const aggregates = aggregateTasksOnPage();
        if (aggregates.length === 0) {
          return new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("status-task:toggle")
              .setPlaceholder("Account chưa có task nào")
              .setDisabled(true)
              .addOptions([{ label: "(empty)", value: "noop" }])
          );
        }
        const options = aggregates.slice(0, 25).map((agg) => {
          const allDone = agg.doneCount === agg.owners.length;
          const icon = allDone ? UI.icons.done : UI.icons.pending;
          const label = truncateText(
            `${icon} ${agg.name} · ${agg.reset} (${agg.doneCount}/${agg.owners.length})`,
            100
          );
          // Value shape `__all__::<reset>::<lowercaseName>` so the
          // toggle handler can re-resolve owners safely. lowercaseName
          // because aggregateTasksOnPage keys on normalized name.
          return {
            label,
            value: `__all__::${agg.reset}::${agg.name.trim().toLowerCase()}`.slice(0, 100),
          };
        });
        return new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("status-task:toggle")
            .setPlaceholder("Bulk toggle task cho mọi char...")
            .setDisabled(disabled)
            .addOptions(options)
        );
      }
      const account = accounts[currentPage];
      const character = (account?.characters || []).find(
        (c) =>
          getCharacterName(c).trim().toLowerCase() ===
          activeName.trim().toLowerCase()
      );
      const sideTasks =
        character && Array.isArray(character.sideTasks)
          ? character.sideTasks
          : [];
      if (sideTasks.length === 0) {
        return new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("status-task:toggle")
            .setPlaceholder(`${activeName} chưa có task - dùng /raid-task add`)
            .setDisabled(true)
            .addOptions([{ label: "(empty)", value: "noop" }])
        );
      }
      const options = sideTasks.slice(0, 25).map((task) => {
        // Match raid-view icon set (UI.icons.done/pending) + drop the
        // calendar emoji which Discord rendered as a bare "17" tile in
        // some clients. Cycle (daily/weekly) shown as text suffix so
        // the dropdown stays readable when both cycles coexist.
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        const label = truncateText(
          `${icon} ${task.name} · ${task.reset}`,
          100
        );
        return {
          label,
          value: `${activeName}::${task.taskId}`.slice(0, 100),
        };
      });
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-task:toggle")
          .setPlaceholder(`Toggle task của ${activeName}...`)
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    const buildComponents = (disabled) => {
      const rows = [];
      const showSync = statusUserMeta.autoManageEnabled;
      if (currentView === "task") {
        // Task view layout: pagination (>1 account) + view toggle +
        // char filter (when account has tasks) + task toggle dropdown.
        // The char filter is the round-28 fix for the > 25-task cap -
        // it scopes the toggle to one char so the dropdown always fits
        // Discord's 25-option ceiling.
        if (accounts.length > 1) {
          rows.push(
            buildPaginationRow(currentPage, accounts.length, disabled, {
              prevId: "status:prev",
              nextId: "status:next",
            })
          );
        }
        rows.push(buildViewToggleRow(disabled));
        const charFilterRow = buildTaskCharFilterRow(disabled);
        if (charFilterRow) rows.push(charFilterRow);
        rows.push(buildTaskToggleRow(disabled));
        return rows;
      }
      if (accounts.length > 1) {
        // Append Sync into the same row as Prev/Next so the 3 buttons
        // sit on a single line ([◀ Previous] [Next ▶] [🔄 Sync (Xm)])
        // instead of taking 2 rows. ActionRow caps at 5 buttons; we
        // use 3 max so plenty of headroom.
        const paginationRow = buildPaginationRow(currentPage, accounts.length, disabled, {
          prevId: "status:prev",
          nextId: "status:next",
        });
        if (showSync) {
          paginationRow.addComponents(buildSyncButton(disabled));
        }
        rows.push(paginationRow);
      } else if (showSync) {
        // Single account: no pagination row to merge into, so Sync gets
        // its own dedicated row (otherwise the button would be missing
        // entirely for users with 1 roster).
        rows.push(buildSyncRow(disabled));
      }
      // View toggle row sits BEFORE the raid filter so the visual hierarchy
      // is "navigation (page/sync) → mode (raid/task view) → in-mode filter
      // (raid filter)". Toggle is always shown so the user can discover the
      // task view even when the raid roster is empty.
      rows.push(buildViewToggleRow(disabled));
      // Skip the raid-filter row when the caller has no eligible raids
      // at all (empty roster / all chars below minItemLevel gates) -
      // dropdown with only the All-raids entry is just noise.
      if (raidDropdownEntries.length > 0) {
        rows.push(buildRaidFilterRow(disabled));
      }
      return rows;
    };

    const initialComponents = buildComponents(false);

    await interaction.editReply({
      embeds: [buildCurrentEmbed()],
      components: initialComponents,
    });

    // No interactive surface (single account + no eligible raids) - skip
    // the collector entirely. Without this guard the collector would
    // spin for STATUS_PAGINATION_SESSION_MS doing nothing.
    if (initialComponents.length === 0) return;

    const message = await interaction.fetchReply();

    // No componentType filter - collector must listen to both Button
    // (prev/next) AND StringSelect (raid filter) interactions.
    const collector = message.createMessageComponentCollector({
      time: STATUS_PAGINATION_SESSION_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        await component.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: "Chỉ người mở mới điều khiển được",
              description: "Pagination này thuộc session `/raid-status` của người khác nha cậu, Artist chỉ cho người chạy lệnh thao tác. Mở session riêng bằng `/raid-status` của mình nhé.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const id = component.customId || "";
      if (id === "status:prev") {
        currentPage = Math.max(0, currentPage - 1);
      } else if (id === "status:next") {
        currentPage = Math.min(accounts.length - 1, currentPage + 1);
      } else if (id === "status:sync") {
        // Manual Sync button - same gather+apply pipeline as the open-time
        // piggyback in handleStatusCommand, but triggered on demand.
        // Cooldown still gates via acquireAutoManageSyncSlot; on reject
        // we surface the remaining wait via ephemeral followup so the
        // click feels acknowledged.
        if (!statusUserMeta.autoManageEnabled) {
          await component.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: "Cậu chưa bật auto-sync",
                description: "Sync button chỉ chạy được khi cậu đã `/raid-auto-manage action:on`. Gõ lệnh đó trước rồi quay lại bấm Sync nha~",
              }),
            ],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
          return;
        }
        let manualGuard = null;
        const manualOutcome = { outcome: "not-applicable", newGatesApplied: 0 };
        try {
          manualGuard = await acquireAutoManageSyncSlot(discordId);
          if (!manualGuard.acquired) {
            const cooldownMs =
              typeof getAutoManageCooldownMs === "function"
                ? getAutoManageCooldownMs(discordId)
                : AUTO_MANAGE_SYNC_COOLDOWN_MS;
            const remain =
              formatNextCooldownRemaining(
                Number(statusUserMeta.lastAutoManageAttemptAt) || 0,
                cooldownMs
              ) || "vài giây";
            await component.reply({
              embeds: [
                buildNoticeEmbed(EmbedBuilder, {
                  type: "info",
                  title: "Đang trong cooldown",
                  description: `Cậu vừa sync gần đây nha, đợi thêm **${remain}** nữa rồi bấm Sync tiếp được.`,
                }),
              ],
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
            return;
          }
          await component.deferUpdate().catch(() => {});
          const weekResetStart = weekResetStartMs();
          const seedDocLocal = await User.findOne({ discordId });
          if (!seedDocLocal) {
            manualOutcome.outcome = "failed";
          } else {
            ensureFreshWeek(seedDocLocal);
            let collectedLocal = null;
            try {
              collectedLocal = await gatherAutoManageLogsForUserDoc(
                seedDocLocal,
                weekResetStart
              );
            } catch (gatherErr) {
              console.warn(
                "[raid-status manual-sync] gather failed:",
                gatherErr?.message || gatherErr
              );
              manualOutcome.outcome = "failed";
            }
            if (collectedLocal) {
              await saveWithRetry(async () => {
                const fresh = await User.findOne({ discordId });
                if (!fresh) return;
                ensureFreshWeek(fresh);
                if (!fresh.autoManageEnabled) {
                  fresh.lastAutoManageAttemptAt = Date.now();
                  await fresh.save();
                  return;
                }
                const report = applyAutoManageCollected(
                  fresh,
                  weekResetStart,
                  collectedLocal
                );
                const now = Date.now();
                fresh.lastAutoManageAttemptAt = now;
                if (report.perChar.some((c) => !c.error)) {
                  fresh.lastAutoManageSyncAt = now;
                }
                const newGates = report.perChar.reduce(
                  (sum, e) =>
                    sum + (Array.isArray(e.applied) ? e.applied.length : 0),
                  0
                );
                manualOutcome.newGatesApplied = newGates;
                manualOutcome.outcome =
                  newGates > 0 ? "applied" : "synced-no-new";
                await fresh.save();
              });
            }
          }
        } catch (err) {
          console.error(
            "[raid-status manual-sync] unexpected error:",
            err?.message || err
          );
          manualOutcome.outcome = "failed";
          await stampAutoManageAttempt(discordId).catch(() => {});
        } finally {
          if (manualGuard?.acquired) releaseAutoManageSyncSlot(discordId);
        }

        // Reload userDoc fresh + recompute everything dependent on it.
        // The raidsCache holds per-character refs; .clear() invalidates
        // entries pointing at the old (pre-reload) character objects so
        // baseGetRaidsFor recomputes against the new accounts array.
        const reloaded = await User.findOne({ discordId }).lean();
        if (reloaded && Array.isArray(reloaded.accounts)) {
          userDoc = reloaded;
          accounts = userDoc.accounts;
          statusUserMeta = buildStatusUserMeta(userDoc, manualOutcome);
          raidsCache.clear();
          recomputeRaidAggregate();
          if (currentPage >= accounts.length) {
            currentPage = Math.max(0, accounts.length - 1);
          }
        } else {
          // Doc disappeared somehow - just patch the outcome onto the
          // existing meta so the embed reflects the failed state.
          statusUserMeta = { ...statusUserMeta, piggybackOutcome: manualOutcome };
        }

        await interaction.editReply({
          embeds: [buildCurrentEmbed()],
          components: buildComponents(false),
        }).catch(() => {});

        // Explicit click feedback: the embed re-render alone doesn't
        // tell the user whether the click succeeded or what changed.
        // Followup is ephemeral so it auto-dismisses for the user
        // without cluttering the channel for others (the original
        // /raid-status reply isn't ephemeral by default).
        let followupCopy = null;
        let followupType = "info";
        if (manualOutcome.outcome === "applied") {
          const n = manualOutcome.newGatesApplied || 0;
          followupCopy = `Artist vừa sync xong, có **${n}** gate mới được apply nha~`;
          followupType = "success";
        } else if (manualOutcome.outcome === "synced-no-new") {
          followupCopy =
            "Sync xong rồi, không có gate mới so với cache. Embed đã refresh lại nha~";
          followupType = "info";
        } else if (manualOutcome.outcome === "failed") {
          followupCopy =
            "Bible đang dở chứng, sync chưa lấy được data mới. Cooldown đã reset, cậu thử lại sau vài phút giúp tớ nhé~";
          followupType = "warn";
        }
        if (followupCopy) {
          await component
            .followUp({
              embeds: [
                buildNoticeEmbed(EmbedBuilder, {
                  type: followupType,
                  title:
                    followupType === "success"
                      ? "Đã sync xong"
                      : followupType === "warn"
                        ? "Sync gặp trục trặc"
                        : "Đã sync",
                  description: followupCopy,
                }),
              ],
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
        return;
      } else if (id === "status-filter:raid") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : FILTER_ALL_RAIDS;
        filterRaidId = value === FILTER_ALL_RAIDS ? null : value;
        // Do NOT reset currentPage - raid filter is orthogonal to page
        // structure (pages still map 1:1 to accounts, only what each
        // page displays internally changes). Resetting to page 0 on
        // filter pick would feel broken: "I was viewing account 3, why
        // did I jump back to account 1 just because I filtered a raid?"
      } else if (id === "status-view:toggle") {
        const picked =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : "raid";
        currentView = picked === "task" ? "task" : "raid";
      } else if (id === "status-task:char-filter") {
        const picked =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : "";
        if (picked) {
          taskCharFilterByPage.set(currentPage, picked);
        }
      } else if (id === "status-task:toggle") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : "";
        if (!value || value === "noop") {
          await component.deferUpdate().catch(() => {});
          return;
        }
        // Bulk-toggle path. Value shape `__all__::<reset>::<lowerName>`.
        // Aggregate the task across every char on the page that owns it
        // (matched by lowercase name + reset cycle), then flip:
        //   - if every owner is done → mark all undone
        //   - else → mark all done
        // One save covers the batch.
        if (value.startsWith("__all__::")) {
          const parts = value.split("::");
          const targetReset = parts[1] || "";
          const targetNameLower = parts.slice(2).join("::");
          if (!targetReset || !targetNameLower) {
            await component.deferUpdate().catch(() => {});
            return;
          }
          // Bind by accountName captured at click-time, not by currentPage
          // index. If the account list was mutated between session start
          // and this click (e.g. concurrent /remove-roster shrunk the
          // list), userDocFresh.accounts[currentPage] could now point at
          // a different account and we'd write the toggle into the wrong
          // roster. Refind by normalized name inside the save closure.
          const targetAccountName = accounts[currentPage]?.accountName || "";
          if (!targetAccountName) {
            await component.deferUpdate().catch(() => {});
            return;
          }
          try {
            await saveWithRetry(async () => {
              const userDocFresh = await User.findOne({ discordId });
              if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;
              const account = userDocFresh.accounts.find(
                (a) => normalizeName(a?.accountName) === normalizeName(targetAccountName)
              );
              if (!account || !Array.isArray(account.characters)) return;
              // Find every char that owns the matching (name, reset) task.
              const owners = [];
              for (const ch of account.characters) {
                if (!Array.isArray(ch?.sideTasks)) continue;
                const task = ch.sideTasks.find(
                  (t) =>
                    String(t?.name || "").trim().toLowerCase() === targetNameLower &&
                    t?.reset === targetReset
                );
                if (task) owners.push({ task });
              }
              if (owners.length === 0) return;
              const allDone = owners.every((o) => o.task.completed);
              const nextState = !allDone;
              for (const { task } of owners) {
                task.completed = nextState;
              }
              await userDocFresh.save();
            });
          } catch (err) {
            console.error(
              "[raid-status side-task bulk-toggle] save failed:",
              err?.message || err
            );
          }
          const reloaded = await User.findOne({ discordId }).lean();
          if (reloaded && Array.isArray(reloaded.accounts)) {
            userDoc = reloaded;
            accounts = userDoc.accounts;
          }
        } else {
          const sepIdx = value.indexOf("::");
          const targetCharName = sepIdx > 0 ? value.slice(0, sepIdx) : "";
          const targetTaskId = sepIdx > 0 ? value.slice(sepIdx + 2) : "";
          if (!targetCharName || !targetTaskId) {
            await component.deferUpdate().catch(() => {});
            return;
          }
          // Same accountName binding as the bulk-toggle path - resolve
          // the account by stable name rather than by currentPage index
          // so a concurrent roster-list mutation can't redirect the
          // single-task toggle into a different account.
          const targetAccountName = accounts[currentPage]?.accountName || "";
          if (!targetAccountName) {
            await component.deferUpdate().catch(() => {});
            return;
          }
          try {
            await saveWithRetry(async () => {
              const userDocFresh = await User.findOne({ discordId });
              if (!userDocFresh || !Array.isArray(userDocFresh.accounts)) return;
              const account = userDocFresh.accounts.find(
                (a) => normalizeName(a?.accountName) === normalizeName(targetAccountName)
              );
              if (!account || !Array.isArray(account.characters)) return;
              const target = account.characters.find(
                (c) =>
                  String(c?.name || "").trim().toLowerCase() ===
                  targetCharName.trim().toLowerCase()
              );
              if (!target) return;
              if (!Array.isArray(target.sideTasks)) target.sideTasks = [];
              const task = target.sideTasks.find((t) => t?.taskId === targetTaskId);
              if (!task) return;
              task.completed = !task.completed;
              await userDocFresh.save();
            });
          } catch (err) {
            console.error(
              "[raid-status side-task toggle] save failed:",
              err?.message || err
            );
          }
          // Reload the view-local accounts snapshot so the next embed render
          // reflects the just-toggled state. Cheap lean read scoped to the
          // single discordId, no bible round-trip.
          const reloaded = await User.findOne({ discordId }).lean();
          if (reloaded && Array.isArray(reloaded.accounts)) {
            userDoc = reloaded;
            accounts = userDoc.accounts;
          }
        }
      } else {
        return;
      }

      await component.update({
        embeds: [buildCurrentEmbed()],
        components: buildComponents(false),
      }).catch(() => {});
    });

    collector.on("end", async () => {
      try {
        const expiredFooter =
          `⏱️ Session đã hết hạn (${STATUS_PAGINATION_SESSION_MS / 1000}s) · Dùng /raid-status để xem lại`;
        const expiredEmbed = EmbedBuilder.from(buildCurrentEmbed()).setFooter({
          text: expiredFooter,
        });
        await interaction.editReply({
          embeds: [expiredEmbed],
          components: buildComponents(true),
        });
      } catch {
        // Interaction token may have expired.
      }
    });
  }

  return {
    handleStatusCommand,
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
  };
}

module.exports = {
  createRaidStatusCommand,
  STATUS_PAGINATION_SESSION_MS,
  STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
};
