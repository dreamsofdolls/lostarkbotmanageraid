const { createSnapshotHelpers } = require("./raid-check/snapshot");
const { createEditHelpers } = require("./raid-check/edit-helpers");
const { createAllModeHandler } = require("./raid-check/all-mode");
const { createEditUi } = require("./raid-check/edit-ui");
const { createSyncUi } = require("./raid-check/sync-ui");
const { isSupportClass, getClassEmoji } = require("../data/Class");
const { buildNoticeEmbed } = require("../raid/shared");

const RAID_CHECK_PAGINATION_SESSION_MS = 5 * 60 * 1000;

// Bible-piggyback budget for /raid-check command-open. Mirrors the
// /raid-status piggyback pattern (STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS
// = 2500ms) so render isn't held hostage by slow bible. Slow gathers
// keep running in the background after the budget elapses; the user
// just sees the pre-piggyback render and can hit Sync if they want
// the in-flight write to land before re-render.
const RAID_CHECK_PIGGYBACK_BUDGET_MS = 2500;

// Cap the per-open piggyback at this many opted-in pending users.
// Above this threshold the piggyback is skipped entirely - the manager
// should use the explicit Sync button (no budget cap there) for
// heavy-backlog raids. Keeps a single /raid-check open from spending
// the per-instance bible budget on an entire guild.
const RAID_CHECK_PIGGYBACK_MAX_USERS = 8;

function createRaidCheckCommand(deps) {
  const {
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    toModeLabel,
    getCharacterName,
    truncateText,
    formatShortRelative,
    waitWithBudget,
    getGatesForRaid,
    ensureAssignedRaids,
    getGateKeys,
    getRaidScanRange,
    buildRaidCheckUserQuery,
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
    summarizeRaidProgress,
    getStatusRaidsForCharacter,
    buildPaginationRow,
    pickProgressIcon,
    resolveDiscordDisplay,
    loadFreshUserSnapshotForRaidViews,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    autoManageEntryKey,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    stampAutoManageAttempt,
    weekResetStartMs,
    isRaidLeader,
    isManagerId,
    getAutoManageCooldownMs,
    applyRaidSetForDiscordId,
    RAID_REQUIREMENT_MAP,
    RAID_CHECK_USER_QUERY_FIELDS,
    ROSTER_KEY_SEP,
    raidCheckRefreshLimiter,
    raidCheckSyncLimiter,
    discordUserLimiter,
  } = deps;

  // Snapshot helpers extracted to ./raid-check/snapshot.js. Wired here so
  // the inner handlers below can call them directly without threading deps.
  const {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    computeRaidCheckSnapshot,
  } = createSnapshotHelpers({
    User,
    buildRaidCheckUserQuery,
    RAID_CHECK_USER_QUERY_FIELDS,
    UI,
    ROSTER_KEY_SEP,
    toModeLabel,
    normalizeName,
    getRaidScanRange,
    ensureFreshWeek,
    ensureAssignedRaids,
    getCharacterName,
    getGateKeys,
    getGatesForRaid,
    raidCheckRefreshLimiter,
    loadFreshUserSnapshotForRaidViews,
  });

  // Pure edit-flow helpers extracted to ./raid-check/edit-helpers.js.
  const {
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    formatGateStateLine,
    applyLocalRaidEditToChar,
    formatCharEditLabel,
    formatUserEditLabel,
  } = createEditHelpers({
    UI,
    normalizeName,
    toModeLabel,
    truncateText,
    getGatesForRaid,
    getGateKeys,
    getRaidScanRange,
    RAID_REQUIREMENT_MAP,
  });

  // /raid-check raid:all handler extracted to ./raid-check/all-mode.js.
  // Bound here so the existing inline call (`await handleRaidCheckAllCommand(...)`)
  // resolves through the local destructure.
  const { handleRaidCheckAllCommand } = createAllModeHandler({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    User,
    ensureFreshWeek,
    truncateText,
    buildAccountPageEmbed,
    buildStatusFooterText,
    summarizeRaidProgress,
    getStatusRaidsForCharacter,
    buildPaginationRow,
    isRaidLeader,
    isManagerId,
    discordUserLimiter,
    RAID_CHECK_PAGINATION_SESSION_MS,
  });

  // Sync flow + shared display-name resolver extracted to
  // ./raid-check/sync-ui.js. Wired BEFORE createEditUi because edit-ui
  // consumes resolveCachedDisplayName as a dep (Edit cascade resolves
  // display names per editable user). The same resolver is also called
  // from the main /raid-check render path below, so the destructure has
  // to land before any handler body that references it gets invoked.
  const {
    resolveCachedDisplayName,
    buildRaidCheckSyncDMEmbed,
    handleRaidCheckSyncClick,
  } = createSyncUi({
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    ensureFreshWeek,
    normalizeName,
    saveWithRetry,
    weekResetStartMs,
    autoManageEntryKey,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    stampAutoManageAttempt,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    raidCheckSyncLimiter,
    discordUserLimiter,
    resolveDiscordDisplay,
    computeRaidCheckSnapshot,
  });

  // Per-user piggyback bible-sync wrapped in a slot guard. Same pipeline
  // handleRaidCheckSyncClick uses, scoped to ONE user's pending entries
  // for THIS raid via includeEntryKeys so each per-user bible call is
  // narrow. Returns true iff the apply landed at least one new gate.
  // Errors are swallowed (logged) - piggyback is best-effort by design.
  async function piggybackBibleSyncForUser(discordId, raidMeta, snapshot, weekResetStart) {
    const guard = await acquireAutoManageSyncSlot(discordId);
    if (!guard.acquired) return false;
    try {
      const seedDoc = await User.findOne({ discordId });
      if (
        !seedDoc?.autoManageEnabled ||
        !Array.isArray(seedDoc.accounts) ||
        seedDoc.accounts.length === 0
      ) {
        return false;
      }
      ensureFreshWeek(seedDoc);

      // Narrow the bible call to JUST this user's pending entries in
      // the raid currently being viewed - no point gathering logs for
      // chars / raids the leader isn't looking at on this open.
      const includeEntryKeys = new Set();
      for (const ch of snapshot.pendingChars) {
        if (ch.discordId === discordId) {
          includeEntryKeys.add(autoManageEntryKey(ch.accountName, ch.charName));
        }
      }
      if (includeEntryKeys.size === 0) return false;

      const collected = await gatherAutoManageLogsForUserDoc(
        seedDoc,
        weekResetStart,
        { includeEntryKeys }
      );
      let appliedSomething = false;
      await saveWithRetry(async () => {
        const fresh = await User.findOne({ discordId });
        if (!fresh || !Array.isArray(fresh.accounts) || fresh.accounts.length === 0) return;
        ensureFreshWeek(fresh);
        if (!fresh.autoManageEnabled) {
          fresh.lastAutoManageAttemptAt = Date.now();
          await fresh.save();
          return;
        }
        const report = applyAutoManageCollected(fresh, weekResetStart, collected);
        const now = Date.now();
        fresh.lastAutoManageAttemptAt = now;
        if (report.perChar.some((c) => !c.error)) {
          fresh.lastAutoManageSyncAt = now;
          if (report.perChar.some((c) => Array.isArray(c.applied) && c.applied.length > 0)) {
            appliedSomething = true;
          }
        }
        await fresh.save();
      });
      return appliedSomething;
    } catch (err) {
      console.warn(
        `[raid-check piggyback] user ${discordId} failed:`,
        err?.message || err
      );
      try { await stampAutoManageAttempt(discordId); } catch {}
      return false;
    } finally {
      releaseAutoManageSyncSlot(discordId);
    }
  }

  // Open-time bible piggyback. Scoped to opted-in users with at least
  // one pending char in the raid being viewed. Skips entirely when the
  // cohort is empty OR larger than MAX_USERS (heavy backlog raids
  // belong to the explicit Sync button, not the per-open piggyback).
  // Race against BUDGET_MS so a slow bible doesn't hold render hostage;
  // any in-flight gather past budget keeps running in background and
  // its save still updates lastAutoManageSyncAt for the next open.
  async function tryBiblePiggybackForOpen(snapshot, raidMeta) {
    const optedInDiscordIds = [
      ...new Set(snapshot.pendingChars.map((c) => c.discordId)),
    ].filter((id) => snapshot.userMeta.get(id)?.autoManageEnabled);

    if (optedInDiscordIds.length === 0) return false;
    if (optedInDiscordIds.length > RAID_CHECK_PIGGYBACK_MAX_USERS) {
      console.log(
        `[raid-check piggyback] skip raid=${raidMeta.raidKey}:${raidMeta.modeKey} (${optedInDiscordIds.length} opted-in users > cap ${RAID_CHECK_PIGGYBACK_MAX_USERS}); use Sync button instead`
      );
      return false;
    }

    const started = Date.now();
    const weekResetStart = weekResetStartMs();
    const allPiggybackPromise = Promise.all(
      optedInDiscordIds.map((discordId) =>
        raidCheckSyncLimiter.run(() =>
          piggybackBibleSyncForUser(discordId, raidMeta, snapshot, weekResetStart)
        )
      )
    );

    const budgetResult = await waitWithBudget(
      allPiggybackPromise,
      RAID_CHECK_PIGGYBACK_BUDGET_MS
    );
    const elapsedMs = Date.now() - started;

    if (budgetResult.timedOut) {
      console.log(
        `[raid-check piggyback] budget exceeded raid=${raidMeta.raidKey}:${raidMeta.modeKey} users=${optedInDiscordIds.length} elapsedMs=${elapsedMs}; rendering pre-piggyback data, gathers continuing in background`
      );
      // Don't await the background settle - those gathers' saves stamp
      // lastAutoManageSyncAt so the NEXT open picks them up.
      allPiggybackPromise.catch(() => {});
      return false;
    }

    const appliedAny = budgetResult.value.some((applied) => applied);
    console.log(
      `[raid-check piggyback] done raid=${raidMeta.raidKey}:${raidMeta.modeKey} users=${optedInDiscordIds.length} appliedAny=${appliedAny} elapsedMs=${elapsedMs}`
    );
    return appliedAny;
  }

  async function handleRaidCheckCommand(interaction) {
    if (!isRaidLeader(interaction)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: "Chỉ Raid Manager mới được dùng",
            description: "Lệnh `/raid-check` chỉ Raid Manager mới chạy được nha cậu (config qua env `RAID_MANAGER_ID`). Gõ `/raid-status` nếu cậu muốn xem progress của roster mình.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const raidKey = interaction.options.getString("raid", true);
    // All-mode is a synthetic choice that does NOT map to a raidMeta
    // entry. It pulls a cross-raid overview (per-account page with
    // every eligible raid per char, mirrors /raid-status layout) so
    // the leader can scan the whole guild without running one
    // /raid-check per raid×mode.
    if (raidKey === "all") {
      await handleRaidCheckAllCommand(interaction);
      return;
    }
    const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
    if (!raidMeta) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Raid option không hợp lệ",
            description: "Artist không nhận diện được raid cậu chọn. Gõ lại `/raid-check` rồi chọn từ dropdown nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let snapshot = await computeRaidCheckSnapshot(raidMeta, { syncFreshData: true });

    // Light bible-piggyback so /raid-check no longer feels stale on open.
    // Without this the render reflected only data the daily background
    // ticker (24h gap) or someone's prior /raid-status had already
    // written. Manager would have to click Sync manually every time to
    // see fresh progress - exactly the UX gap Traine flagged.
    //
    // Scope: opted-in users with at least one pending char in THIS raid.
    // Cap at MAX_USERS; above that the explicit Sync button is the
    // right tool (no budget cap, full guild reach). Per-user gather
    // scopes its bible call to JUST that user's pending chars via
    // includeEntryKeys, so multi-user piggyback is still cheap.
    //
    // Budget: BUDGET_MS cap - if the bible is slow we render with
    // pre-piggyback data and let the in-flight gathers finish in the
    // background (their save still updates lastAutoManageSyncAt for the
    // next /raid-check open).
    const piggybacked = await tryBiblePiggybackForOpen(snapshot, raidMeta);
    if (piggybacked) {
      snapshot = await computeRaidCheckSnapshot(raidMeta, { syncFreshData: false });
    }

    const {
      allEligible,
      pendingChars,
      userMeta,
      rosterRefreshMap,
      rosterRefreshAttemptMap,
    } = snapshot;
    const renderChars = getRaidCheckRenderableChars({ allEligible });

    const modeKey = normalizeName(raidMeta.modeKey);
    const difficultyColor =
      modeKey === "nightmare"
        ? UI.colors.danger
        : modeKey === "hard"
          ? UI.colors.progress
          : UI.colors.neutral;

    if (pendingChars.length === 0) {
      const description = allEligible.length > 0
        ? `Toan bo **${allEligible.length}** eligible character da hoan thanh **${raidMeta.label}**.\nAll eligible characters have completed this raid.`
        : `No eligible characters found for **${raidMeta.label}** at this item-level threshold.`;
      const emptyEmbed = new EmbedBuilder()
        .setTitle(`${UI.icons.done} Raid Check · ${raidMeta.label}`)
        .setColor(UI.colors.success)
        .setDescription(description)
        .setTimestamp();
      // Edit button stays available even on the empty-state path so a
      // leader can Reset a DONE char for a re-clear, or fix an incorrect
      // stamp, without having to find another raid that still has
      // pending chars first. Matches the "Edit button always enabled"
      // contract at buildButtonRow. Only suppress it when there's
      // literally no char in scope (allChars === 0) because the Edit
      // cascade would then have nothing to show.
      const hasEditableChar =
        Array.isArray(allEligible) && allEligible.length > 0;
      const components = hasEditableChar
        ? [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`raid-check:edit:${raidKey}`)
                .setLabel("Edit progress")
                .setEmoji("✏️")
                .setStyle(ButtonStyle.Secondary)
            ),
          ]
        : [];
      // Button click routing: bot.js's global InteractionCreate listener
      // auto-dispatches any `raid-check:*` customId to handleRaidCheckButton
      // (see bot.js line ~168), so we don't install a local collector on
      // this path. Interaction token expires in 15 min; after that a click
      // will fail silently in Discord's UI, same as any stale ephemeral.
      await interaction.editReply({ embeds: [emptyEmbed], components });
      return;
    }

    const visibleDiscordIds = [...new Set(renderChars.map((c) => c.discordId))];
    const displayMap = new Map();
    await Promise.all(
      visibleDiscordIds.map(async (discordId) => {
        const meta = userMeta.get(discordId) || {};
        const displayName = await resolveCachedDisplayName(
          interaction.client,
          discordId,
          meta
        );
        displayMap.set(discordId, displayName);
      })
    );

    const rosterBuckets = new Map();
    for (const item of renderChars) {
      const key = item.discordId + ROSTER_KEY_SEP + item.accountName;
      if (!rosterBuckets.has(key)) rosterBuckets.set(key, []);
      rosterBuckets.get(key).push(item);
    }
    for (const chars of rosterBuckets.values()) {
      chars.sort((a, b) => b.itemLevel - a.itemLevel);
    }

    const userTotalPending = new Map();
    for (const item of pendingChars) {
      userTotalPending.set(item.discordId, (userTotalPending.get(item.discordId) || 0) + 1);
    }

    const rosterStats = new Map();
    const bumpStat = (key, field) => {
      if (!rosterStats.has(key)) {
        rosterStats.set(key, { none: 0, partial: 0, done: 0, notEligible: 0 });
      }
      rosterStats.get(key)[field] += 1;
    };
    for (const item of allEligible) {
      const key = item.discordId + ROSTER_KEY_SEP + item.accountName;
      if (item.overallStatus === "complete") bumpStat(key, "done");
      else if (item.overallStatus === "partial") bumpStat(key, "partial");
      else bumpStat(key, "none");
    }
    const rosterGroups = [...rosterBuckets.entries()]
      .map(([key, chars]) => {
        const [discordId, accountName] = key.split(ROSTER_KEY_SEP);
        const meta = userMeta.get(discordId) || {};
        const stats = rosterStats.get(key) || { none: 0, partial: 0, done: 0, notEligible: 0 };
        const lastRefreshedAt = rosterRefreshMap.get(key) || 0;
        const lastRefreshAttemptAt = rosterRefreshAttemptMap.get(key) || 0;
        const rosterPending = (stats.partial || 0) + (stats.none || 0);
        return {
          discordId,
          accountName,
          displayName: displayMap.get(discordId) || discordId,
          chars,
          stats,
          lastRefreshedAt,
          lastRefreshAttemptAt,
          rosterPending,
          partialCount: chars.filter((c) => c.overallStatus === "partial").length,
          autoManageEnabled: meta.autoManageEnabled || false,
          lastAutoManageSyncAt: meta.lastAutoManageSyncAt || 0,
          lastAutoManageAttemptAt: meta.lastAutoManageAttemptAt || 0,
        };
      })
      .sort((a, b) => {
        const totalDiff =
          (userTotalPending.get(b.discordId) || 0) - (userTotalPending.get(a.discordId) || 0);
        if (totalDiff !== 0) return totalDiff;

        const pendingDiff = b.rosterPending - a.rosterPending;
        if (pendingDiff !== 0) return pendingDiff;

        const nameDiff = a.displayName.localeCompare(b.displayName);
        if (nameDiff !== 0) return nameDiff;

        return a.accountName.localeCompare(b.accountName);
      });

    const headerTitle = `${UI.icons.warn} Raid Check · ${raidMeta.label} (${raidMeta.minItemLevel})`;

    // Surface bible-sync freshness in the footer because /raid-check itself
    // does NOT pull bible (only the explicit Sync button + the daily
    // background ticker do). Without this hint a leader could not tell
    // whether the pending list reflects last-minute progress or 23h-stale
    // data. We use the OLDEST opted-in user's lastAutoManageSyncAt across
    // the visible groups - "fresh" requires every visible user to be
    // recent. Non-opted-in users are skipped (they never auto-sync, so a
    // null timestamp on them isn't a freshness problem).
    const formatLastBibleSyncLine = (groups) => {
      let oldestSyncAt = Infinity;
      let optedInCount = 0;
      let neverSyncedCount = 0;
      for (const group of groups) {
        const meta = snapshot.userMeta.get(group.discordId);
        if (!meta?.autoManageEnabled) continue;
        optedInCount += 1;
        const syncAt = Number(meta.lastAutoManageSyncAt) || 0;
        if (syncAt <= 0) {
          neverSyncedCount += 1;
          oldestSyncAt = 0;
        } else if (syncAt < oldestSyncAt) {
          oldestSyncAt = syncAt;
        }
      }
      if (optedInCount === 0) return null;
      if (oldestSyncAt === 0) {
        return `${UI.icons.info} bible: ${neverSyncedCount}/${optedInCount} chưa sync lần nào`;
      }
      return `${UI.icons.info} bible: oldest ${formatShortRelative(oldestSyncAt)} · bấm Sync để pull mới`;
    };

    const buildFooterText = (groups) => {
      let done = 0;
      let partial = 0;
      let none = 0;
      let notEligible = 0;
      for (const group of groups) {
        const stats = group.stats || {};
        done += stats.done || 0;
        partial += stats.partial || 0;
        none += stats.none || 0;
        notEligible += stats.notEligible || 0;
      }
      const parts = [
        `${UI.icons.done} ${done} done`,
        `${UI.icons.partial} ${partial} partial`,
        `${UI.icons.pending} ${none} pending`,
      ];
      if (notEligible > 0) parts.push(`${UI.icons.lock} ${notEligible} not eligible`);
      const syncLine = formatLastBibleSyncLine(groups);
      const counts = parts.join(" · ");
      return syncLine ? `${counts}\n${syncLine}` : counts;
    };

    const buildCharField = (character) => {
      // Class emoji prepended to the char name when the class is mapped in
      // CLASS_EMOJI_MAP (Discord guild emoji uploads). Empty string when
      // unmapped - safe no-op fallback so the field renders cleanly while
      // emoji are still being uploaded one class at a time.
      const classIcon = getClassEmoji(character.className);
      const namePrefix = classIcon ? `${classIcon} ` : "";
      const name = truncateText(`${namePrefix}${character.charName} · ${Math.round(character.itemLevel)}`, 256);
      if (character.overallStatus === "not-eligible") {
        return {
          name,
          value: truncateText(formatRaidCheckNotEligibleFieldValue(character), 1024),
          inline: true,
        };
      }

      const doneCount = character.gateStatus.filter((status) => status === "done").length;
      const total = character.gateStatus.length;
      const icon = pickProgressIcon(doneCount, total);
      // If the clear was recorded at another mode, or this page is showing an
      // out-of-range explicit clear, annotate the actual mode so leaders can
      // distinguish "2/2 Nightmare" from "2/2 (Normal Clear)".
      const modeSuffix = character.doneModeAnnotation
        ? ` _(${character.doneModeAnnotation})_`
        : "";
      return {
        name,
        value: truncateText(`${icon} ${doneCount}/${total}${modeSuffix}`, 1024),
        inline: true,
      };
    };

    const inlineSpacer = { name: "\u200B", value: "\u200B", inline: true };
    const ROSTERS_PER_PAGE = 2;
    const FILTER_ALL = "__all__";

    // Per-user pending tally + role breakdown so the user-filter dropdown
    // can render "Du · 8 pending (2🛡️ 6⚔️)" instead of bare "(8 pending)".
    // Hard-support classes (Bard / Paladin / Artist / Valkyrie) get the
    // 🛡️ bucket; everything else is DPS. Without this split it's hard to
    // tell whether a heavy backlog is composition-blocking (no supports
    // ready) or just queue depth.
    const userPendingTotals = new Map();
    for (const item of pendingChars) {
      let entry = userPendingTotals.get(item.discordId);
      if (!entry) {
        entry = { total: 0, supports: 0, dps: 0 };
        userPendingTotals.set(item.discordId, entry);
      }
      entry.total += 1;
      if (isSupportClass(item.className)) entry.supports += 1;
      else entry.dps += 1;
    }
    const userDropdownEntries = [...userPendingTotals.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 24);

    const filterByUser = (userId) => {
      if (!userId || userId === FILTER_ALL) return rosterGroups;
      return rosterGroups.filter((group) => group.discordId === userId);
    };

    const chunkRosters = (groups) => {
      const chunks = [];
      for (let i = 0; i < groups.length; i += ROSTERS_PER_PAGE) {
        chunks.push(groups.slice(i, i + ROSTERS_PER_PAGE));
      }
      return chunks;
    };

    const addRosterSection = (embed, group) => {
      const freshnessLine = buildAccountFreshnessLine(group, group);

      // Swap the folder icon for a crown when the roster belongs to a Raid
      // Manager. Keeps the manager cue visible once per roster instead of
      // stamping every char name (which gets scan-hostile in a long list and
      // would fight the planned class-icon swap on the char line).
      const headerIcon = isManagerId && isManagerId(group.discordId)
        ? "👑"
        : UI.icons.folder;
      // Inline `· 📝 Auto-sync OFF` badge so the leader immediately sees
      // which rosters won't be touched by the auto-manage scheduler. Silent
      // when opted-in (the freshness line below already shows the
      // last-synced timestamp); the OFF badge is the only one rendered
      // because manual-handling rosters are the exception that needs
      // action (Edit cascade or nudging the member to opt in).
      const autoSyncBadge = group.autoManageEnabled ? "" : " · 📝 Auto-sync OFF";
      embed.addFields({
        name: truncateText(`${headerIcon} ${group.accountName} (${group.displayName})${autoSyncBadge}`, 256),
        value: truncateText(freshnessLine || "\u200B", 1024),
        inline: false,
      });
      for (let i = 0; i < group.chars.length; i += 2) {
        embed.addFields(buildCharField(group.chars[i]));
        embed.addFields(inlineSpacer);
        embed.addFields(group.chars[i + 1] ? buildCharField(group.chars[i + 1]) : inlineSpacer);
      }
    };

    const buildRaidCheckPage = (rosterChunk, pageIndex, totalPages, visibleGroups) => {
      const baseFooter = buildFooterText(visibleGroups || rosterChunk);
      const pageFooter =
        totalPages > 1 ? `${baseFooter} · Page ${pageIndex + 1}/${totalPages}` : baseFooter;
      const embed = new EmbedBuilder()
        .setTitle(headerTitle)
        .setColor(difficultyColor)
        .setFooter({ text: pageFooter })
        .setTimestamp();

      if (selectedUserId) {
        const displayName = displayMap.get(selectedUserId) || selectedUserId;
        const authorPayload = { name: displayName };
        if (selectedUserAvatar) authorPayload.iconURL = selectedUserAvatar;
        embed.setAuthor(authorPayload);
      }

      for (const group of rosterChunk) {
        addRosterSection(embed, group);
      }
      return embed;
    };

    const buildEmptyFilterEmbed = (userId) =>
      new EmbedBuilder()
        .setTitle(headerTitle)
        .setDescription(
          `${UI.icons.done} **${(userId && displayMap.get(userId)) || "this user"}** không có char nào pending trong ${raidMeta.label}.`
        )
        .setColor(UI.colors.success)
        .setFooter({ text: buildFooterText(rosterGroups) })
        .setTimestamp();

    const pendingDiscordIdSet = new Set(pendingChars.map((c) => c.discordId));
    const optedInPendingCount = new Set(
      rosterGroups
        .filter((group) => group.autoManageEnabled && pendingDiscordIdSet.has(group.discordId))
        .map((group) => group.discordId)
    ).size;

    const buildButtonRow = (currentPage, totalPages, disabled, selectedId = null) => {
      const row = buildPaginationRow(currentPage, totalPages, disabled, {
        prevId: "raid-check-page:prev",
        nextId: "raid-check-page:next",
      });
      // Hide Sync + Edit when the user filter narrows the view to one
      // specific user. Both actions are designed for the bulk "All users"
      // view: Sync runs across every opted-in pending user (counter-
      // intuitive when the leader is currently focused on one), and Edit
      // cascade lets the leader pick any user/char (which would visually
      // contradict the "I'm filtering to user X" intent). Pagination still
      // useful for browsing the filtered user's accounts; the filter
      // dropdown stays so the leader can revert to All or switch user.
      if (selectedId) {
        return row;
      }
      // Sync button only renders when at least one pending user has opted
      // into /raid-auto-manage. Parity with /raid-status, where the Sync
      // button is hidden entirely when the owner is opted-out (clicking a
      // disabled "no opted-in users" button is just visual noise). When 0
      // opted-in, leaders fall back to Edit cascade for manual progress
      // updates instead.
      if (optedInPendingCount > 0) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:sync:${raidKey}`)
            .setLabel(`Sync ${optedInPendingCount} opted-in user(s)`)
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
        );
      }
      // Leader edit flow. Always enabled (as long as session is live) - the
      // user/char select lists are computed fresh per click off the latest
      // snapshot, so a click here opens an ephemeral follow-up regardless
      // of whether there are pending chars (a leader may want to `reset`
      // a DONE char too).
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`raid-check:edit:${raidKey}`)
          .setLabel("Edit progress")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      );
      return row;
    };

    const buildFilterDropdown = (selectedId, disabled) => {
      const allDefault = !selectedId || selectedId === FILTER_ALL;
      const options = [
        {
          label: truncateText(
            `All users (${pendingChars.length === 0 ? "DONE" : `${pendingChars.length} pending`})`,
            100
          ),
          value: FILTER_ALL,
          emoji: "🌐",
          default: allDefault,
        },
        ...userDropdownEntries.map(([discordId, tally]) => {
          // Collapse the role-breakdown suffix when the user has 0 pending -
          // "(0 pending · 0🛡️ 0⚔️)" reads as noise that takes longer to parse
          // than the more informative "(DONE)". Only the DONE marker stays
          // so leaders can scan the dropdown for who's still actually
          // outstanding without filtering by hand.
          const suffix = tally.total === 0
            ? "DONE"
            : `${tally.total} pending · ${tally.supports}🛡️ ${tally.dps}⚔️`;
          return {
            label: truncateText(
              `${displayMap.get(discordId) || discordId} (${suffix})`,
              100
            ),
            value: discordId,
            emoji: "👤",
            default: selectedId === discordId,
          };
        }),
      ];
      const menu = new StringSelectMenuBuilder()
        .setCustomId("raid-check-filter:user")
        .setPlaceholder("Filter by user / Lọc theo user...")
        .setDisabled(disabled)
        .addOptions(options);
      return new ActionRowBuilder().addComponents(menu);
    };

    const buildComponents = (currentPage, totalPages, selectedId, disabled) => ([
      buildButtonRow(currentPage, totalPages, disabled, selectedId),
      buildFilterDropdown(selectedId, disabled),
    ]);

    let selectedUserId = null;
    let selectedUserAvatar = null;
    const initialFiltered = filterByUser(selectedUserId);
    let pages = chunkRosters(initialFiltered).map((chunk, idx, arr) =>
      buildRaidCheckPage(chunk, idx, arr.length, initialFiltered)
    );
    let currentPage = 0;

    await interaction.editReply({
      embeds: [pages[currentPage]],
      components: buildComponents(currentPage, pages.length, selectedUserId, false),
    });

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      time: RAID_CHECK_PAGINATION_SESSION_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        const ours =
          (component.customId || "").startsWith("raid-check-page:") ||
          component.customId === "raid-check-filter:user";
        if (ours) {
          await component.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "lock",
                title: "Chỉ người mở mới điều khiển được",
                description: "Pagination này thuộc session `/raid-check` của người khác nha cậu, Artist chỉ cho người chạy lệnh thao tác. Mở session riêng bằng `/raid-check` của mình nhé.",
              }),
            ],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }
        return;
      }

      if (component.customId === "raid-check-page:prev") {
        currentPage = Math.max(0, currentPage - 1);
      } else if (component.customId === "raid-check-page:next") {
        currentPage = Math.min(pages.length - 1, currentPage + 1);
      } else if (component.customId === "raid-check-filter:user") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : FILTER_ALL;
        selectedUserId = value === FILTER_ALL ? null : value;
        if (selectedUserId) {
          try {
            let userObj = interaction.client.users.cache.get(selectedUserId);
            if (!userObj) {
              userObj = await discordUserLimiter.run(() =>
                interaction.client.users.fetch(selectedUserId)
              );
            }
            selectedUserAvatar = userObj ? userObj.displayAvatarURL({ size: 64 }) : null;
          } catch {
            selectedUserAvatar = null;
          }
        } else {
          selectedUserAvatar = null;
        }

        const filtered = filterByUser(selectedUserId);
        pages = chunkRosters(filtered).map((chunk, idx, arr) =>
          buildRaidCheckPage(chunk, idx, arr.length, filtered)
        );
        currentPage = 0;
        if (pages.length === 0) {
          await component.update({
            embeds: [buildEmptyFilterEmbed(selectedUserId)],
            components: [buildFilterDropdown(selectedUserId, false)],
          }).catch(() => {});
          return;
        }
      } else {
        return;
      }

      await component.update({
        embeds: [pages[currentPage]],
        components: buildComponents(currentPage, pages.length, selectedUserId, false),
      }).catch(() => {});
    });

    collector.on("end", async () => {
      try {
        const expiredFooter =
          `⏱️ Session đã hết hạn (${RAID_CHECK_PAGINATION_SESSION_MS / 1000}s) · Dùng /raid-check để xem lại`;
        const source = pages[currentPage] || pages[0];
        const expiredEmbed = EmbedBuilder.from(source).setFooter({ text: expiredFooter });
        await interaction.editReply({
          embeds: [expiredEmbed],
          components: buildComponents(currentPage, pages.length, selectedUserId, true),
        });
      } catch {
        // Interaction token may have expired.
      }
    });
  }

  async function handleRaidCheckButton(interaction) {
    if (!isRaidLeader(interaction)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: "Chỉ Raid Manager mới dùng được",
            description: "Button này thuộc về flow `/raid-check` của Raid Manager nha cậu. Người khác bấm Artist từ chối luôn.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const parts = interaction.customId.split(":");
    const action = parts[1];
    const raidKey = parts[2];

    // edit-all has no raidKey in the customId because the raid is picked
    // inside the Edit UI via a dropdown. Handle it before the raidMeta
    // validation gate below, which would otherwise reject the missing
    // raidKey as "invalid raid".
    //
    // parts[2] carries the discordId of the user currently shown on the
    // source page (the all-mode Edit button rebuilds its customId per
    // page flip). Used as pre-select so clicking Edit while viewing
    // Bao's page opens with Bao pre-picked once the leader chooses a
    // raid. Empty string / falsy means no pre-select (defensive - the
    // all-mode code always includes a discordId today).
    if (action === "edit-all") {
      const preSelectedUserId = parts[2] || null;
      await handleRaidCheckEditClick(interaction, null, null, preSelectedUserId);
      return;
    }

    const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
    if (!raidMeta) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Button đã hết hạn",
            description: "Raid trong button không còn hợp lệ (có thể session cũ hoặc bot vừa restart). Gõ `/raid-check` lại để refresh nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "sync") {
      await handleRaidCheckSyncClick(interaction, raidMeta);
    } else if (action === "edit") {
      // Pass the combined `raid_mode` key (the RAID_REQUIREMENT_MAP key)
      // alongside raidMeta so the Edit flow can lock selectedRaid to the
      // same key the map uses. raidMeta.raidKey alone is just the raid
      // portion ("serca") and would break every RAID_REQUIREMENT_MAP
      // lookup downstream.
      await handleRaidCheckEditClick(interaction, raidMeta, raidKey);
    } else {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Button action không hỗ trợ",
            description: `Action \`${action}\` không khớp với flow Artist biết. Có thể button cũ từ build trước, gõ \`/raid-check\` lại để refresh nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const RAID_CHECK_EDIT_SESSION_MS = 3 * 60 * 1000;

  // Edit cascading-select flow extracted to ./raid-check/edit-ui.js.
  // Consumes resolveCachedDisplayName from the sync-ui factory above, so
  // sync-ui has to be wired first. RAID_CHECK_EDIT_SESSION_MS is the local
  // const right above. The 6 returned functions cross-call each other
  // through their shared closure, so we destructure and bind locally so
  // the call sites below stay unchanged.
  const {
    buildEditEmbed,
    buildEditComponents,
    handleRaidCheckEditClick,
    postEditSessionExpiredNotice,
    buildRaidCheckEditDMEmbed,
    applyEditAndConfirm,
  } = createEditUi({
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User,
    normalizeName,
    truncateText,
    RAID_REQUIREMENT_MAP,
    resolveDiscordDisplay,
    resolveCachedDisplayName,
    discordUserLimiter,
    applyRaidSetForDiscordId,
    computeRaidCheckSnapshot,
    buildEditableCharsByUser,
    getCharRaidGateStatus,
    formatGateStateLine,
    formatCharEditLabel,
    formatUserEditLabel,
    applyLocalRaidEditToChar,
    RAID_CHECK_EDIT_SESSION_MS,
  });

  // Cross-raid overview for /raid-check raid:all. Mirrors /raid-status's
  // per-account page layout so the leader sees ONE account at a time
  // (inline 2-col char fields, account progress rollup, freshness badge)
  // but scoped across every user in the guild instead of just the
  // caller's own roster. Pagination flips through all (user, account)
  // pairs; each page carries a setAuthor avatar + display name so the
  // leader can tell users apart without reading the roster label. Edit
  // button is intentionally omitted in this commit - cross-raid Edit
  // needs a raid dropdown cascade (Commit 2); leaders who want to edit
  // should open /raid-check with a specific raid×mode for now.

  return {
    buildRaidCheckSnapshotFromUsers,
    formatRaidCheckNotEligibleFieldValue,
    getRaidCheckRenderableChars,
    computeRaidCheckSnapshot,
    buildEditableCharsByUser,
    getEligibleRaidsForChar,
    getCharRaidGateStatus,
    applyLocalRaidEditToChar,
    buildRaidCheckEditDMEmbed,
    handleRaidCheckCommand,
    handleRaidCheckButton,
  };
}

module.exports = {
  createRaidCheckCommand,
  RAID_CHECK_PAGINATION_SESSION_MS,
};
