const RAID_CHECK_PAGINATION_SESSION_MS = 5 * 60 * 1000;

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
    getGatesForRaid,
    ensureAssignedRaids,
    getGateKeys,
    getRaidScanRange,
    modeRank,
    buildRaidCheckUserQuery,
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
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

  function buildRaidCheckSnapshotFromUsers(users, raidMeta) {
    const userMeta = new Map();
    const rosterRefreshMap = new Map();
    const rosterRefreshAttemptMap = new Map();
    const allEligible = [];
    const notEligibleChars = [];
    const selectedDifficulty = toModeLabel(raidMeta.modeKey);
    const selectedDiffNorm = normalizeName(selectedDifficulty);
    const scanRank = modeRank(selectedDiffNorm);
    const { lowestMin, selfMin, nextMin } = getRaidScanRange(
      raidMeta.raidKey,
      Number(raidMeta.minItemLevel) || 0
    );

    for (const userDoc of users || []) {
      if (!userDoc) continue;
      ensureFreshWeek(userDoc);
      if (!userMeta.has(userDoc.discordId)) {
        userMeta.set(userDoc.discordId, {
          autoManageEnabled: !!userDoc.autoManageEnabled,
          lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
          lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
          // Cached Discord identity strings from the User doc. The Edit
          // flow prefers these (populated the last time the user ran a
          // slash command) over a live client.users.fetch round-trip
          // because discord.js's cached user often only has the raw
          // username handle, not the guild-displayed nickname.
          discordUsername: userDoc.discordUsername || "",
          discordGlobalName: userDoc.discordGlobalName || "",
          discordDisplayName: userDoc.discordDisplayName || "",
        });
      }

      const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
      for (const account of accounts) {
        const rosterKey = userDoc.discordId + ROSTER_KEY_SEP + (account.accountName || "(no name)");
        rosterRefreshMap.set(rosterKey, Number(account.lastRefreshedAt) || 0);
        rosterRefreshAttemptMap.set(rosterKey, Number(account.lastRefreshAttemptAt) || 0);

        const characters = Array.isArray(account.characters) ? account.characters : [];
        for (const character of characters) {
          if (!character) continue;
          const characterItemLevel = Number(character.itemLevel) || 0;
          if (characterItemLevel < lowestMin) continue;

          const assignedRaids = ensureAssignedRaids(character);
          const baseEntry = {
            discordId: userDoc.discordId,
            accountName: account.accountName || "(no name)",
            charName: getCharacterName(character),
            itemLevel: characterItemLevel,
            // Carried forward so the /raid-check Edit flow can decide
            // whether a leader is allowed to touch this char despite the
            // owner having auto-sync enabled - see the Edit-flow auth
            // rule in services/manager-edit-auth or the cascading
            // select builders.
            publicLogDisabled: !!character.publicLogDisabled,
            // Full assignedRaids copy so the Edit flow can show per-gate
            // state for ANY raid the leader picks in the raid dropdown,
            // not just the scanned raidMeta. Without this the cascading
            // select would render "Complete / Process / Reset" with no
            // indication of what's already done, and Complete on an
            // already-done raid would silently no-op server-side after a
            // confusing click. Keeping the whole tree is cheap - each
            // character has at most 3 raids × 2-3 gates.
            assignedRaids,
          };

          const assigned = assignedRaids[raidMeta.raidKey] || {};
          const storedGateKeys = getGateKeys(assigned);
          const officialGates =
            storedGateKeys.length > 0 ? storedGateKeys : getGatesForRaid(raidMeta.raidKey);
          const gateStatus = officialGates.map((gate) => {
            const gateEntry = assigned[gate];
            if (!gateEntry) return "pending";
            const storedRank = modeRank(gateEntry.difficulty);
            if (storedRank < scanRank) return "pending";
            return Number(gateEntry.completedDate) > 0 ? "done" : "pending";
          });

          const doneCount = gateStatus.filter((status) => status === "done").length;
          let overallStatus;
          if (doneCount === officialGates.length) overallStatus = "complete";
          else if (doneCount > 0) overallStatus = "partial";
          else overallStatus = "none";

          // High-side filter distinguishes two out-of-range cases:
          //
          //   (a) OUT-GROWN: char cleared THIS mode at a lower iLvl
          //       earlier in the week, then grew past nextMin. E.g.
          //       Cyracha cleared Serca Normal at 1725, is now 1732.
          //       Their natural tier is Hard now. Filter out -
          //       leader's mental model "/raid-check raid:serca_normal
          //       = chars in [1710, 1730)" should hold.
          //
          //   (b) HIERARCHY: char cleared a HIGHER mode (storedRank
          //       > scanRank). E.g. 1740 char cleared Kazeros Hard,
          //       which via mode hierarchy also counts as Kazeros
          //       Normal clear. Keep visible - leader running
          //       /raid-check kazeros_normal wants to see "who has
          //       cleared Normal-or-higher this week". Hiding the
          //       1740 Hard-cleared char would misrepresent the
          //       Normal cohort's done count.
          //
          // Distinguish by scanning the char's done gates for a
          // stored mode HIGHER than scanRank. If any found, it's a
          // hierarchy case. Otherwise it's out-grown (or plain
          // "none"). Previous behavior only applied this filter for
          // "none" status, which leaked case (a) into the view.
          // Traine report 2026-04-24.
          let doneViaHierarchy = false;
          if (characterItemLevel >= nextMin) {
            for (const gate of officialGates) {
              const entry = assigned[gate];
              if (!entry || !(Number(entry.completedDate) > 0)) continue;
              const storedRank = modeRank(entry.difficulty);
              if (storedRank > scanRank) {
                doneViaHierarchy = true;
                break;
              }
            }
          }
          if (characterItemLevel >= nextMin && !doneViaHierarchy) {
            notEligibleChars.push({
              ...baseEntry,
              gateStatus: [],
              overallStatus: "not-eligible",
              notEligibleReason: "high",
            });
            continue;
          }

          // Low-side filter: only for chars that haven't cleared yet.
          // A char who cleared Act 4 Normal at 1705 and is still 1705
          // when the floor was lifted to 1710 (edge case) keeps their
          // done visibility so the rollup stays accurate for the
          // mode they actually completed. Applying low-side filter
          // unconditionally would invalidate legitimate prior clears.
          if (overallStatus === "none" && characterItemLevel < selfMin) {
            notEligibleChars.push({
              ...baseEntry,
              gateStatus: [],
              overallStatus: "not-eligible",
              notEligibleReason: "low",
            });
            continue;
          }

          // Annotation for done gates that were cleared at a HIGHER
          // mode than scan. Leader scanning Serca Normal wants to know
          // that Cyravelle's 2/2 green came from a Hard clear (via
          // mode hierarchy), not a Normal clear - current render of
          // "🟢 2/2" alone is ambiguous. Collect distinct higher
          // modes used across the done gates; render as "(Hard)" or
          // "(Hard/Nightmare)" suffix in buildCharField. Empty set =
          // all done gates at scan mode = no annotation needed.
          const hierarchyModes = new Set();
          for (let gi = 0; gi < officialGates.length; gi += 1) {
            if (gateStatus[gi] !== "done") continue;
            const entry = assigned[officialGates[gi]];
            if (!entry) continue;
            const storedRank = modeRank(entry.difficulty);
            if (storedRank > scanRank && entry.difficulty) {
              hierarchyModes.add(toModeLabel(entry.difficulty));
            }
          }
          const doneModeAnnotation =
            hierarchyModes.size > 0 ? [...hierarchyModes].join("/") : null;

          allEligible.push({
            ...baseEntry,
            gateStatus,
            overallStatus,
            doneModeAnnotation,
          });
        }
      }
    }

    const completeChars = allEligible.filter((c) => c.overallStatus === "complete");
    const partialChars = allEligible.filter((c) => c.overallStatus === "partial");
    const noneChars = allEligible.filter((c) => c.overallStatus === "none");
    const pendingChars = [...partialChars, ...noneChars];
    const allChars = [...allEligible, ...notEligibleChars];

    return {
      allEligible,
      allChars,
      completeChars,
      partialChars,
      noneChars,
      notEligibleChars,
      pendingChars,
      userMeta,
      rosterRefreshMap,
      rosterRefreshAttemptMap,
    };
  }

  function formatRaidCheckNotEligibleFieldValue(character) {
    if (character?.notEligibleReason === "low") {
      return `${UI.icons.lock} _Not eligible yet (iLvl below min)_`;
    }
    if (character?.notEligibleReason === "high") {
      return `${UI.icons.lock} _Not eligible yet (out-grown this mode)_`;
    }
    return `${UI.icons.lock} _Not eligible yet_`;
  }

  function getRaidCheckRenderableChars(snapshot) {
    return Array.isArray(snapshot?.allEligible) ? [...snapshot.allEligible] : [];
  }

  async function computeRaidCheckSnapshot(raidMeta, { syncFreshData = false } = {}) {
    const started = Date.now();
    const userQuery = buildRaidCheckUserQuery(raidMeta);
    const raidLabel = `${raidMeta?.raidKey || "unknown"}:${raidMeta?.modeKey || "unknown"}`;
    const logSnapshot = (extra) => {
      const parts = Object.entries(extra)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      console.log(
        `[raid-check] snapshot raid=${raidLabel} syncFreshData=${syncFreshData} ${parts} totalMs=${Date.now() - started}`
      );
    };

    if (!syncFreshData) {
      const queryStarted = Date.now();
      const users = await User.find(userQuery)
        .select(RAID_CHECK_USER_QUERY_FIELDS)
        .lean();
      const queryMs = Date.now() - queryStarted;
      const snapshot = buildRaidCheckSnapshotFromUsers(users, raidMeta);
      logSnapshot({
        users: users.length,
        allChars: snapshot.allChars.length,
        pending: snapshot.pendingChars.length,
        queryMs,
      });
      return snapshot;
    }

    const queryStarted = Date.now();
    const seedUsers = await User.find(userQuery).select(RAID_CHECK_USER_QUERY_FIELDS);
    const queryMs = Date.now() - queryStarted;
    const refreshStarted = Date.now();
    const users = await Promise.all(
      seedUsers.map((seedDoc) =>
        raidCheckRefreshLimiter.run(() =>
          loadFreshUserSnapshotForRaidViews(seedDoc, {
            allowAutoManage: false,
            logLabel: "[raid-check]",
          })
        )
      )
    );
    const refreshMs = Date.now() - refreshStarted;
    const snapshot = buildRaidCheckSnapshotFromUsers(users, raidMeta);
    logSnapshot({
      users: seedUsers.length,
      freshUsers: users.filter(Boolean).length,
      allChars: snapshot.allChars.length,
      pending: snapshot.pendingChars.length,
      queryMs,
      refreshMs,
    });
    return snapshot;
  }

  async function handleRaidCheckCommand(interaction) {
    if (!isRaidLeader(interaction)) {
      await interaction.reply({
        content: `${UI.icons.lock} Chỉ Raid Manager mới được dùng \`/raid-check\` (config qua env \`RAID_MANAGER_ID\`).`,
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
        content: `${UI.icons.warn} Raid option không hợp lệ. Vui lòng thử lại.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const {
      allEligible,
      pendingChars,
      userMeta,
      rosterRefreshMap,
      rosterRefreshAttemptMap,
    } = await computeRaidCheckSnapshot(raidMeta, { syncFreshData: true });
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
      return parts.join(" · ");
    };

    const buildCharField = (character) => {
      const name = truncateText(`${character.charName} · ${Math.round(character.itemLevel)}`, 256);
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
      // If any done gate was cleared at a higher mode than the scan
      // (mode hierarchy), annotate with that mode so leader sees the
      // char satisfied this view via Hard/Nightmare, not the scan
      // mode. Same-mode clears render without suffix (the default).
      const hierarchySuffix = character.doneModeAnnotation
        ? ` _(${character.doneModeAnnotation})_`
        : "";
      return {
        name,
        value: truncateText(`${icon} ${doneCount}/${total}${hierarchySuffix}`, 1024),
        inline: true,
      };
    };

    const inlineSpacer = { name: "\u200B", value: "\u200B", inline: true };
    const ROSTERS_PER_PAGE = 2;
    const FILTER_ALL = "__all__";

    const userPendingTotals = new Map();
    for (const item of pendingChars) {
      userPendingTotals.set(item.discordId, (userPendingTotals.get(item.discordId) || 0) + 1);
    }
    const userDropdownEntries = [...userPendingTotals.entries()]
      .sort((a, b) => b[1] - a[1])
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
      embed.addFields({
        name: truncateText(`${headerIcon} ${group.accountName} (${group.displayName})`, 256),
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

    const buildButtonRow = (currentPage, totalPages, disabled) => {
      const row = buildPaginationRow(currentPage, totalPages, disabled, {
        prevId: "raid-check-page:prev",
        nextId: "raid-check-page:next",
      });
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`raid-check:sync:${raidKey}`)
          .setLabel(
            optedInPendingCount > 0
              ? `Sync ${optedInPendingCount} opted-in user(s)`
              : "Sync (no opted-in users)"
          )
          .setEmoji("🔄")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || optedInPendingCount === 0)
      );
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
          label: truncateText(`All users (${pendingChars.length} pending)`, 100),
          value: FILTER_ALL,
          emoji: "🌐",
          default: allDefault,
        },
        ...userDropdownEntries.map(([discordId, total]) => ({
          label: truncateText(`${displayMap.get(discordId) || discordId} (${total} pending)`, 100),
          value: discordId,
          emoji: "👤",
          default: selectedId === discordId,
        })),
      ];
      const menu = new StringSelectMenuBuilder()
        .setCustomId("raid-check-filter:user")
        .setPlaceholder("Filter by user / Lọc theo user...")
        .setDisabled(disabled)
        .addOptions(options);
      return new ActionRowBuilder().addComponents(menu);
    };

    const buildComponents = (currentPage, totalPages, selectedId, disabled) => ([
      buildButtonRow(currentPage, totalPages, disabled),
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
            content: `${UI.icons.lock} Chỉ người chạy \`/raid-check\` mới điều khiển được pagination.`,
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

  function buildRaidCheckSyncDMEmbed(raidMeta, delta) {
    const lines = delta.map((entry) => {
      const applied = Array.isArray(entry.applied) ? entry.applied : [];
      const gateInfo = applied
        .map((item) => `${item.raidLabel || item.raidKey} ${item.gate}`)
        .join(", ");
      return `**${entry.charName}** · ${applied.length} gate mới: ${gateInfo || "_(detail không có)_"}`;
    });

    return new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} Artist vừa sync progress raid giúp cậu`)
      .setDescription(
        [
          "Chào cậu~ Có Raid Manager vừa nhờ Artist pull logs từ bible sync progress raid cho cậu đây nha. Sau khi sync xong, Artist thấy mấy gate mới này cho char của cậu:",
          "",
          ...lines,
          "",
          "Cậu ghé `/raid-status` xem full progress nha~",
        ].join("\n")
      )
      .setTimestamp();
  }

  async function handleRaidCheckButton(interaction) {
    if (!isRaidLeader(interaction)) {
      await interaction.reply({
        content: `${UI.icons.lock} Chỉ Raid Manager mới được dùng button này.`,
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
        content: `${UI.icons.warn} Raid không hợp lệ trong button. Gõ \`/raid-check\` lại để refresh.`,
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
        content: `${UI.icons.warn} Button action không hỗ trợ: \`${action}\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  async function handleRaidCheckSyncClick(interaction, raidMeta) {
    const started = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const snapshotStarted = Date.now();
    const snapshot = await computeRaidCheckSnapshot(raidMeta);
    const snapshotMs = Date.now() - snapshotStarted;

    const pendingEntryKeysByDiscordId = new Map();
    for (const pendingChar of snapshot.pendingChars) {
      if (!snapshot.userMeta.get(pendingChar.discordId)?.autoManageEnabled) continue;
      if (!pendingEntryKeysByDiscordId.has(pendingChar.discordId)) {
        pendingEntryKeysByDiscordId.set(pendingChar.discordId, new Set());
      }
      pendingEntryKeysByDiscordId
        .get(pendingChar.discordId)
        .add(autoManageEntryKey(pendingChar.accountName, pendingChar.charName));
    }
    const optedInDiscordIds = [...pendingEntryKeysByDiscordId.keys()];
    const scopedCharCount = [...pendingEntryKeysByDiscordId.values()].reduce(
      (sum, entryKeys) => sum + entryKeys.size,
      0
    );
    const pendingUserCount = new Set(snapshot.pendingChars.map((c) => c.discordId)).size;
    if (optedInDiscordIds.length === 0) {
      console.log(
        `[raid-check sync] raid=${raidMeta.raidKey}:${raidMeta.modeKey} pendingUsers=${pendingUserCount} optedIn=0 snapshotMs=${snapshotMs} totalMs=${Date.now() - started}`
      );
      await interaction.editReply({
        content: `${UI.icons.info} Không có user nào opt-in \`/raid-auto-manage\` trong list pending. Nhắc họ gõ \`/raid-auto-manage action:on\` hoặc tự update bằng \`/raid-set\`.`,
      });
      return;
    }

    const weekResetStart = weekResetStartMs();
    let syncedCount = 0;
    let attemptedOnlyCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const deltasPerUser = new Map();

    const syncStarted = Date.now();
    await Promise.all(
      optedInDiscordIds.map((discordId) =>
        raidCheckSyncLimiter.run(async () => {
          const guard = await acquireAutoManageSyncSlot(discordId, { ignoreCooldown: true });
          if (!guard.acquired) {
            skippedCount += 1;
            return;
          }

          let bibleHit = false;
          try {
            const seedDoc = await User.findOne({ discordId });
            if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
              skippedCount += 1;
              return;
            }
            if (!seedDoc.autoManageEnabled) {
              skippedCount += 1;
              return;
            }

            ensureFreshWeek(seedDoc);
            const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart, {
              includeEntryKeys: pendingEntryKeysByDiscordId.get(discordId),
            });
            bibleHit = true;

            let outcome = "attempted-only";
            let delta = null;
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
                outcome = "synced";
              }
              const appliedEntries = report.perChar.filter(
                (entry) => Array.isArray(entry.applied) && entry.applied.length > 0
              );
              if (appliedEntries.length > 0) delta = appliedEntries;
              await fresh.save();
            });

            if (outcome === "synced") syncedCount += 1;
            else attemptedOnlyCount += 1;
            if (delta) deltasPerUser.set(discordId, delta);
          } catch (err) {
            failedCount += 1;
            if (bibleHit) await stampAutoManageAttempt(discordId);
            console.warn(`[raid-check sync] user ${discordId} failed:`, err?.message || err);
          } finally {
            releaseAutoManageSyncSlot(discordId);
          }
        })
      )
    );
    const syncMs = Date.now() - syncStarted;

    const dmStarted = Date.now();
    const dmResults = await Promise.all(
      [...deltasPerUser.entries()].map(([discordId, delta]) =>
        discordUserLimiter.run(async () => {
          try {
            const user = await interaction.client.users.fetch(discordId);
            const dmChannel = await user.createDM();
            const embed = buildRaidCheckSyncDMEmbed(raidMeta, delta);
            await dmChannel.send({ embeds: [embed] });
            return { ok: true };
          } catch {
            return { ok: false };
          }
        })
      )
    );
    const dmMs = Date.now() - dmStarted;
    const dmSent = dmResults.filter((result) => result.ok).length;
    const dmFailed = dmResults.length - dmSent;

    console.log(
      `[raid-check sync] raid=${raidMeta.raidKey}:${raidMeta.modeKey} pendingUsers=${pendingUserCount} optedIn=${optedInDiscordIds.length} scopedChars=${scopedCharCount} synced=${syncedCount} attemptedOnly=${attemptedOnlyCount} skipped=${skippedCount} failed=${failedCount} dmSent=${dmSent} dmFailed=${dmFailed} snapshotMs=${snapshotMs} syncMs=${syncMs} dmMs=${dmMs} totalMs=${Date.now() - started}`
    );

    const lines = [
      `${UI.icons.done} Đã trigger sync cho **${optedInDiscordIds.length}** opted-in user (**${scopedCharCount}** pending char).`,
      `- Synced (có data mới): **${syncedCount}** · Attempted-only (no fresh data): **${attemptedOnlyCount}**`,
      `- Skipped (cooldown/in-flight): **${skippedCount}** · Failed: **${failedCount}**`,
      `- Chars có update mới: **${deltasPerUser.size}** user · DM sent: **${dmSent}**${dmFailed > 0 ? ` · DM failed: **${dmFailed}**` : ""}`,
      "",
      `_Gõ \`/raid-check raid:${raidMeta.raidKey}_${normalizeName(raidMeta.modeKey)}\` để xem list pending mới._`,
    ];
    await interaction.editReply({ content: lines.join("\n") });
  }

  // ---------------------------------------------------------------------------
  // /raid-check Edit flow
  // ---------------------------------------------------------------------------
  // Leader picks a user → char → raid → status (Complete / Process / Reset)
  // → (gate if Process) and the bot applies via the same applyRaidSetForDiscordId
  // helper the slash /raid-set path uses. Lives entirely inside an ephemeral
  // follow-up message so the parent /raid-check embed stays clean.
  //
  // Auth rule: user.autoManageEnabled = true AND char.publicLogDisabled = false
  // means bible auto-sync owns this char; the leader's manual edit would be
  // overwritten on the next sync tick, so we skip it from the char select.
  // Auto-sync user's chars where publicLogDisabled = true show up (bible can
  // never sync those, manager is the only path that can move progress).
  // Non-auto-sync users: every char is editable.

  const RAID_CHECK_EDIT_SESSION_MS = 5 * 60 * 1000;

  // Shared display-name resolver for every view inside /raid-check (main
  // render + Edit cascade). Prefers the cached identity strings on the User
  // doc (stamped every slash-command invocation) because those reflect the
  // guild-displayed nickname / global name rather than the raw username
  // handle discord.js's local cache typically holds. Falls back to
  // `resolveDiscordDisplay` (already gated by discordUserLimiter internally)
  // for users whose doc fields are empty, and finally to the snowflake.
  async function resolveCachedDisplayName(client, discordId, meta) {
    const cached =
      meta?.discordDisplayName ||
      meta?.discordGlobalName ||
      meta?.discordUsername ||
      "";
    if (cached) return cached;
    try {
      const live = await resolveDiscordDisplay(client, discordId);
      return live || discordId;
    } catch {
      return discordId;
    }
  }

  /**
   * Partition the snapshot chars into a Map keyed by discordId with the
   * editable subset under each. Edit follows the same eligibility surface as
   * the rendered `/raid-check` list; `allChars` may include not-eligible audit
   * entries, but those should not leak into the cascading select.
   */
  function buildEditableCharsByUser(snapshot) {
    const byUser = new Map();
    const sourceChars = Array.isArray(snapshot.allEligible)
      ? snapshot.allEligible
      : (snapshot.allChars || []);
    for (const char of sourceChars) {
      const meta = snapshot.userMeta.get(char.discordId) || {};
      const autoSyncOn = !!meta.autoManageEnabled;
      // Auto-sync ON + log ON → bible owns, skip.
      if (autoSyncOn && !char.publicLogDisabled) continue;
      if (!byUser.has(char.discordId)) {
        byUser.set(char.discordId, {
          discordId: char.discordId,
          autoManageEnabled: autoSyncOn,
          chars: [],
        });
      }
      byUser.get(char.discordId).chars.push({
        accountName: char.accountName,
        charName: char.charName,
        itemLevel: char.itemLevel,
        publicLogDisabled: !!char.publicLogDisabled,
        autoManageEnabled: autoSyncOn,
        // Carry the normalized assignedRaids tree from the snapshot so
        // getCharRaidGateStatus + applyLocalRaidEditToChar can read + mutate
        // per-gate state without a second DB read. Without this the Edit
        // dropdown entry was a stripped shape, every gate rendered as "⚪
        // chưa clear" even for raids the char had already completed, and
        // the post-apply local mirror had nothing to mutate.
        assignedRaids: char.assignedRaids || {},
      });
    }
    // Sort chars inside each user by iLvl desc so highest-geared surfaces first.
    for (const group of byUser.values()) {
      group.chars.sort((a, b) => b.itemLevel - a.itemLevel);
    }
    return byUser;
  }

  /**
   * Raids this char is eligible for, based on the same mode range contract
   * `/raid-check` uses: a mode is editable only when
   * minItemLevel <= char iLvl < next higher mode min. Highest modes have no
   * upper bound. This keeps a 1730 char from showing Normal options that the
   * scan itself already hides as out-grown.
   */
  function getEligibleRaidsForChar(itemLevel) {
    const level = Number(itemLevel) || 0;
    return Object.entries(RAID_REQUIREMENT_MAP)
      .filter(([, entry]) => {
        const minItemLevel = Number(entry.minItemLevel) || 0;
        if (level < minItemLevel) return false;
        const { nextMin } = getRaidScanRange(entry.raidKey, minItemLevel);
        return level < nextMin;
      })
      .sort((a, b) => {
        const diff = (Number(a[1].minItemLevel) || 0) - (Number(b[1].minItemLevel) || 0);
        if (diff !== 0) return diff;
        return a[0].localeCompare(b[0]);
      })
      .map(([raidKey, entry]) => ({ raidKey, entry }));
  }

  /**
   * Read the gate state for a picked raid off the char's stored
   * assignedRaids tree. Returns per-gate rows (done? current mode?) +
   * a rollup `overallStatus` + `modeChangeNeeded` flag so the Edit UI
   * can disable buttons that would be pure no-ops and warn when the
   * picked mode would wipe a different mode's progress.
   *
   * `modeChangeNeeded` = true means the raid has at least one gate
   * stored at a DIFFERENT difficulty than the picked one. Applying
   * Complete/Process at the picked mode will wipe those gates (see
   * applyRaidSetForDiscordId's `modeResetCount` path) so the leader
   * should get a visible warning before clicking.
   */
  function getCharRaidGateStatus(character, raidKey, modeKey) {
    const assigned = character?.assignedRaids?.[raidKey] || {};
    const officialGates = getGatesForRaid(raidKey) || [];
    const normalizedPickedMode = normalizeName(toModeLabel(modeKey));
    let modeChangeNeeded = false;
    const gates = officialGates.map((gate) => {
      const entry = assigned[gate] || {};
      const storedMode = entry.difficulty
        ? String(entry.difficulty).toLowerCase()
        : null;
      const doneAtSomeMode = Number(entry.completedDate) > 0;
      const doneAtPickedMode =
        doneAtSomeMode && storedMode === normalizedPickedMode;
      if (storedMode && storedMode !== normalizedPickedMode && doneAtSomeMode) {
        modeChangeNeeded = true;
      }
      return {
        gate,
        doneAtPickedMode,
        doneAtSomeMode,
        storedMode,
      };
    });
    const doneCount = gates.filter((g) => g.doneAtPickedMode).length;
    let overallStatus;
    if (gates.length === 0) overallStatus = "unknown";
    else if (doneCount === gates.length) overallStatus = "complete";
    else if (doneCount > 0) overallStatus = "partial";
    else overallStatus = "none";
    return { gates, overallStatus, modeChangeNeeded };
  }

  function formatGateStateLine(gateStatus, raidKey) {
    if (!gateStatus || gateStatus.overallStatus === "unknown") return null;
    const parts = gateStatus.gates.map((g) => {
      if (g.doneAtPickedMode) return `🟢 ${g.gate}`;
      if (g.doneAtSomeMode) return `🟠 ${g.gate} (${g.storedMode})`;
      return `⚪ ${g.gate}`;
    });
    const rollup = gateStatus.overallStatus === "complete"
      ? "DONE"
      : gateStatus.overallStatus === "partial"
        ? "partial"
        : "chưa clear";
    return `${parts.join(" · ")}  _(${rollup})_`;
  }

  function applyLocalRaidEditToChar(character, raidMeta, statusType, effectiveGates, now = Date.now()) {
    if (!character || !raidMeta) return;
    const selectedDifficulty = toModeLabel(raidMeta.modeKey);
    const normalizedSelectedDiff = normalizeName(selectedDifficulty);
    const officialGates = getGatesForRaid(raidMeta.raidKey) || [];
    const gateList = Array.isArray(effectiveGates) ? effectiveGates.filter(Boolean) : [];
    if (!character.assignedRaids) character.assignedRaids = {};

    const raidData = character.assignedRaids[raidMeta.raidKey] || {};
    let modeChangeDetected = false;
    for (const gate of officialGates) {
      const existingDiff = raidData[gate]?.difficulty;
      if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
        modeChangeDetected = true;
        break;
      }
    }
    if (modeChangeDetected) {
      for (const gate of officialGates) {
        raidData[gate] = { difficulty: selectedDifficulty, completedDate: undefined };
      }
    }

    const storedGateKeys = getGateKeys(raidData);
    const targetGates =
      gateList.length > 0 ? gateList :
      storedGateKeys.length > 0 ? storedGateKeys :
      officialGates;
    const shouldMarkDone = statusType === "complete" || statusType === "process";
    for (const gate of targetGates) {
      raidData[gate] = {
        difficulty: selectedDifficulty,
        completedDate: shouldMarkDone ? now : null,
      };
    }
    character.assignedRaids[raidMeta.raidKey] = raidData;
  }

  function formatCharEditLabel(char, raidMeta) {
    // Base: "Cyrano · 1733"
    const parts = [char.charName, String(Math.round(char.itemLevel))];

    // Progress hint for the raid the leader is scanning (state.raidMeta),
    // so they can see which chars still need work WITHOUT having to pick
    // each one and wait for the gate buttons to render. Uses the same
    // rollup as formatGateStateLine for visual consistency:
    //   🟢 DONE  - every gate done at the picked mode
    //   🟠 X/Y   - some gates done at the picked mode
    //   🟡 khác mode - nothing done at picked mode but char has cleared
    //                  at a different difficulty (apply would wipe it)
    //   ⚪ 0/Y   - untouched at this raid entirely
    if (raidMeta?.raidKey) {
      const gateStatus = getCharRaidGateStatus(
        char,
        raidMeta.raidKey,
        raidMeta.modeKey
      );
      const total = gateStatus.gates.length;
      if (total > 0) {
        const done = gateStatus.gates.filter((g) => g.doneAtPickedMode).length;
        if (gateStatus.overallStatus === "complete") {
          parts.push(`🟢 ${done}/${total}`);
        } else if (gateStatus.overallStatus === "partial") {
          parts.push(`🟠 ${done}/${total}`);
        } else if (gateStatus.modeChangeNeeded) {
          parts.push("🟡 khác mode");
        } else {
          parts.push(`⚪ ${done}/${total}`);
        }
      }
    }

    if (char.autoManageEnabled && char.publicLogDisabled) {
      parts.push("log off");
    }
    return truncateText(parts.join(" · "), 100);
  }

  function formatUserEditLabel(group, displayName) {
    const tag = group.autoManageEnabled ? " · auto-sync" : "";
    const count = group.chars.length;
    return truncateText(`${displayName} · ${count} editable${tag}`, 100);
  }

  function buildEditEmbed(state) {
    // Pick the next step hint so the leader always knows which dropdown
    // to look at. The dropdown itself also updates live but a dense UI
    // with 3 selects stacked needs a verbal anchor in the embed too.
    let nextStep = null;
    if (state.applied) {
      nextStep = "Xong~ Bấm ✖️ Close để đóng, hoặc gõ lại `/raid-check` xem pending list mới.";
    } else if (state.scopeAll && !state.raidMeta) {
      nextStep = "Pick **raid + difficulty** trước nhé - tớ sẽ load roster editable cho raid đó.";
    } else if (state.scopeAll && state.editableByUser.size === 0) {
      nextStep = "Raid này không có user/char nào edit được (floor quá cao hoặc mọi char thuộc user auto-sync + log on). Đổi raid khác xem~";
    } else if (!state.selectedUser) {
      nextStep = "Pick **user** cần chỉnh progress nhé (dropdown ngay bên dưới).";
    } else if (!state.selectedChar) {
      nextStep = `Giờ chọn **character** trong roster của bạn đó. Icon trong label theo progress của **${state.raidMeta.label}**: 🟢 DONE · 🟠 partial · 🟡 khác mode · ⚪ chưa clear.`;
    } else if (state.awaitingGate) {
      nextStep = "Pick **gate** (G1/G2) cho status Process - chỉ gate đó được đánh dấu done.";
    } else {
      nextStep = "Cuối cùng bấm **✅ Complete** (full raid), **📝 Process** (1 gate), hay **🔄 Reset** (xoá sạch).";
    }

    // User label priorities (in order):
    //   1. Explicit selection (state.selectedUser) - post-pick state
    //   2. scopeAll pre-select carried from the all-mode source page -
    //      pending raid pick but we show it so leader sees context
    //   3. Nothing picked yet
    let userLabel;
    if (state.selectedUser) {
      userLabel = state.displayMap.get(state.selectedUser) || state.selectedUser;
    } else if (
      state.scopeAll &&
      state.preSelectedUserId &&
      state.preSelectedDisplayName
    ) {
      userLabel = `${state.preSelectedDisplayName} _(sẽ auto-pick sau khi cậu chọn raid)_`;
    } else {
      userLabel = "_chưa chọn_";
    }
    const charLabel = state.selectedChar
      ? `${state.selectedChar.charName} · ${Math.round(state.selectedChar.itemLevel)}${state.selectedChar.publicLogDisabled ? " · 🔒 log off" : ""}`
      : "_chưa chọn_";
    const raidLabel = state.selectedRaid
      ? RAID_REQUIREMENT_MAP[state.selectedRaid]?.label ||
        state.raidMeta?.label ||
        state.selectedRaid
      : "_chưa chọn_";

    // Header copy changes per mode. All-mode leader can flip raids
    // mid-session (cascade resets when they do), while specific-raid
    // mode locks to whatever /raid-check was opened against.
    const headerLine = state.scopeAll
      ? (state.raidMeta
          ? `Artist đang giúp cậu edit progress cross-raid~ Đang làm việc trên **${raidLabel}**. Đổi raid qua dropdown bất cứ lúc nào - cascade sẽ reset.`
          : "Artist giúp cậu edit progress cross-raid nhé~ Pick **raid + difficulty** trước để tớ load roster.")
      : `Artist dẫn cậu chỉnh progress giúp member nhé~ Edit này scope cho **${raidLabel}** thôi, cậu chỉ cần chọn **user → char → status**.`;

    const raidLineSuffix = state.scopeAll
      ? (state.raidMeta ? " _(đổi qua dropdown)_" : "")
      : " _(lock theo /raid-check)_";

    const description = [
      headerLine,
      "",
      `🧍 **User:** ${userLabel}`,
      `⚔️ **Character:** ${charLabel}`,
      `🎯 **Raid:** ${raidLabel}${raidLineSuffix}`,
    ];

    // Show live gate state once a raid is picked so the leader can see
    // what's already done before picking a status button. 🟢 = done at
    // the picked mode, 🟠 = done at a DIFFERENT mode (Complete/Process
    // at the new mode will wipe it), ⚪ = pending.
    if (state.selectedChar && state.selectedRaid) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = getCharRaidGateStatus(
        state.selectedChar,
        raidMeta?.raidKey,
        raidMeta?.modeKey
      );
      const gateLine = formatGateStateLine(gateStatus, raidMeta?.raidKey);
      if (gateLine) {
        description.push(`📊 **Current:** ${gateLine}`);
      }
      if (gateStatus.modeChangeNeeded) {
        description.push(
          `${UI.icons.warn} _Char đang clear ở **mode khác** - bấm Complete/Process sẽ wipe progress cũ trước khi mark mode mới._`
        );
      }
      if (gateStatus.overallStatus === "complete") {
        description.push(
          `${UI.icons.info} _Raid này đã DONE sẵn - Complete và Process đều no-op, chỉ Reset có hiệu quả._`
        );
      }
    }

    description.push("");
    description.push(`👉 ${nextStep}`);

    if (state.selectedChar?.autoManageEnabled && state.selectedChar?.publicLogDisabled) {
      description.push("");
      description.push(`${UI.icons.warn} _Char này thuộc user đã bật auto-sync nhưng public log tắt - edit tay sẽ không bị bible ghi đè nhé._`);
    }

    const embed = new EmbedBuilder()
      .setTitle("✏️ Chỉnh progress giúp member")
      .setColor(state.applied ? UI.colors.success : UI.colors.neutral)
      .setDescription(description.join("\n"));

    if (state.applied && state.message) {
      embed.addFields({ name: "Kết quả", value: state.message });
    }
    if (!state.applied && state.warning) {
      embed.addFields({ name: "Lưu ý", value: state.warning });
    }

    embed.setFooter({ text: `Session ${RAID_CHECK_EDIT_SESSION_MS / 60_000} phút · chỉ cậu thao tác được` });
    return embed;
  }

  function buildEditComponents(state) {
    const rows = [];
    const disabled = state.applied || state.locked;

    // Row 1 (scopeAll only): Raid dropdown sits on top because in
    // all-mode the snapshot itself has to be re-loaded per picked raid
    // (editableByUser changes per raid×mode). Per Traine's ordering
    // note: "nếu thêm all raid thì raid dropdown nằm trên char" - the
    // same logic applies to user select: picking a raid filters which
    // users have any editable char. Specific-raid mode does NOT render
    // this row because the raid is locked upstream.
    if (state.scopeAll) {
      const raidOptions = Object.entries(RAID_REQUIREMENT_MAP)
        .sort(([, a], [, b]) => a.minItemLevel - b.minItemLevel)
        .slice(0, 25)
        .map(([raidKey, entry]) => ({
          label: truncateText(`${entry.label} · ${entry.minItemLevel}+`, 100),
          value: raidKey,
          default: state.selectedRaid === raidKey,
        }));
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("raid-check-edit:raid")
            .setPlaceholder("Chọn raid + difficulty trước...")
            .setDisabled(disabled)
            .addOptions(raidOptions)
        )
      );
    }

    // In scopeAll, bail out if no raid picked yet - the user / char
    // rows below reach into state.editableByUser, which is only
    // populated AFTER a raid pick loads its snapshot.
    if (state.scopeAll && !state.raidMeta) return rows;

    // Row 2 (or Row 1 when not scopeAll): user select. Always present
    // when we have a snapshot so leader can re-pick.
    const userOptions = [...state.editableByUser.values()]
      .slice(0, 25)
      .map((group) => ({
        label: formatUserEditLabel(group, state.displayMap.get(group.discordId) || group.discordId),
        value: group.discordId,
        emoji: group.autoManageEnabled ? "🤖" : "👤",
        default: state.selectedUser === group.discordId,
      }));
    if (userOptions.length > 0) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("raid-check-edit:user")
            .setPlaceholder("Chọn user cần edit...")
            .setDisabled(disabled)
            .addOptions(userOptions)
        )
      );
    }

    // Char select (only when user picked).
    if (state.selectedUser) {
      const group = state.editableByUser.get(state.selectedUser);
      const charOptions = (group?.chars || [])
        .slice(0, 25)
        .map((char) => ({
          label: formatCharEditLabel(char, state.raidMeta),
          value: `${char.accountName}||${char.charName}`,
          emoji: char.publicLogDisabled ? "🔒" : "⚔️",
          default:
            state.selectedChar?.charName === char.charName &&
            state.selectedChar?.accountName === char.accountName,
        }));
      if (charOptions.length > 0) {
        rows.push(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("raid-check-edit:char")
              .setPlaceholder("Chọn character...")
              .setDisabled(disabled)
              .addOptions(charOptions)
          )
        );
      }
    }

    // In specific-raid mode, state.raidMeta is locked at init to whatever
    // /raid-check was opened against. In scopeAll mode, picking the raid
    // dropdown above triggers a snapshot reload that sets raidMeta and
    // rebuilds editableByUser, so the user/char rows below stay valid
    // for the picked raid. Either way, applyEditAndConfirm reads
    // state.selectedRaid (the combined map key) for RAID_REQUIREMENT_MAP.

    // Status buttons (only when char picked). Disable Complete
    // when the raid is already done at the picked mode (would be a
    // no-op server-side) and disable Process when there are no open
    // gates left to mark. Reset is always enabled - it's useful even
    // on a complete raid (e.g. undoing an accidental mark).
    if (state.selectedChar) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = getCharRaidGateStatus(
        state.selectedChar,
        raidMeta?.raidKey,
        raidMeta?.modeKey
      );
      const allGatesDoneAtPickedMode = gateStatus?.overallStatus === "complete";
      const hasOpenGateAtPickedMode = gateStatus
        ? gateStatus.gates.some((g) => !g.doneAtPickedMode)
        : true;

      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("raid-check-edit:status:complete")
            .setLabel("Complete")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled || allGatesDoneAtPickedMode),
          new ButtonBuilder()
            .setCustomId("raid-check-edit:status:process")
            .setLabel("Process (1 gate)")
            .setEmoji("📝")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || !hasOpenGateAtPickedMode),
          new ButtonBuilder()
            .setCustomId("raid-check-edit:status:reset")
            .setLabel("Reset")
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
          new ButtonBuilder()
            .setCustomId("raid-check-edit:cancel")
            .setLabel(state.applied ? "Close" : "Cancel")
            .setEmoji("✖️")
            .setStyle(ButtonStyle.Secondary)
        )
      );
    }

    // Gate buttons (only when Process mode entered). Gate buttons
    // reflect current state: 🟢 emoji + disabled for gates already done
    // at the picked mode (re-marking would be a no-op), 🟠 for gates
    // done at a different mode (clicking triggers the mode-wipe path),
    // ⚪ for clean pending.
    if (state.selectedChar && state.awaitingGate) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = getCharRaidGateStatus(
        state.selectedChar,
        raidMeta?.raidKey,
        raidMeta?.modeKey
      );
      const gateRow = new ActionRowBuilder();
      for (const g of gateStatus.gates.slice(0, 5)) {
        const btn = new ButtonBuilder()
          .setCustomId(`raid-check-edit:gate:${g.gate}`)
          .setLabel(g.gate)
          .setDisabled(disabled || g.doneAtPickedMode);
        if (g.doneAtPickedMode) {
          btn.setEmoji("🟢").setStyle(ButtonStyle.Secondary);
        } else if (g.doneAtSomeMode) {
          btn.setEmoji("🟠").setStyle(ButtonStyle.Primary);
        } else {
          btn.setEmoji("⚪").setStyle(ButtonStyle.Primary);
        }
        gateRow.addComponents(btn);
      }
      if (gateRow.components.length > 0) rows.push(gateRow);
    }

    return rows;
  }

  async function handleRaidCheckEditClick(interaction, raidMeta, raidKey, preSelectedUserId = null) {
    const started = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Two entry modes:
    //   - specific-raid: raidMeta + raidKey passed in, we preload the
    //     snapshot + editableByUser + displayMap for exactly that raid.
    //   - scopeAll (raidMeta null): no preload; leader picks raid via
    //     a dropdown inside the Edit UI, and the `raid` action handler
    //     below loads the per-raid snapshot on the fly.
    //
    // preSelectedUserId: scopeAll-only hint carrying the discordId of
    // the user shown on the source all-mode page. Applied after the
    // leader picks a raid, IF that user has at least one editable char
    // for the picked raid. If not (floor too high / fully auto-sync
    // with log-on), the pre-select silently drops and user dropdown
    // works as normal.
    const scopeAll = !raidMeta;

    let editableByUser = new Map();
    let displayMap = new Map();
    let snapshot = null;

    // Resolve pre-select display name upfront so the User line shows
    // context from the very first render, not just after the leader
    // picks a raid. Without this, leader clicks Edit from Du's page,
    // sees "User: chưa chọn" until they also pick a raid - which
    // reads as "context was lost" even though the discordId is
    // stashed in state.
    let preSelectedDisplayName = null;
    if (scopeAll && preSelectedUserId) {
      try {
        const preDoc = await User.findOne({ discordId: preSelectedUserId })
          .select("discordUsername discordGlobalName discordDisplayName")
          .lean();
        const cached =
          preDoc?.discordDisplayName ||
          preDoc?.discordGlobalName ||
          preDoc?.discordUsername ||
          "";
        if (cached) {
          preSelectedDisplayName = cached;
        } else {
          preSelectedDisplayName = await resolveDiscordDisplay(
            interaction.client,
            preSelectedUserId
          );
        }
      } catch (err) {
        console.warn(
          `[raid-check edit scopeAll] pre-select display resolve failed for ${preSelectedUserId}:`,
          err?.message || err
        );
        preSelectedDisplayName = preSelectedUserId;
      }
    }

    if (!scopeAll) {
      snapshot = await computeRaidCheckSnapshot(raidMeta);
      editableByUser = buildEditableCharsByUser(snapshot);

      if (editableByUser.size === 0) {
        await interaction.editReply({
          content: `${UI.icons.info} Không có char nào available để edit (raid floor ${raidMeta.minItemLevel}+ và không có char thuộc user đã tắt auto-sync hoặc có log off).`,
        });
        return;
      }

      // Resolve display names for just the editable users, via the shared
      // cache-first helper. See resolveCachedDisplayName for why we prefer the
      // User doc's cached identity over discord.js's own users cache.
      await Promise.all(
        [...editableByUser.keys()].map(async (discordId) => {
          const meta = snapshot.userMeta.get(discordId) || {};
          const name = await resolveCachedDisplayName(
            interaction.client,
            discordId,
            meta
          );
          displayMap.set(discordId, name);
        })
      );
    }

    const state = {
      scopeAll,
      raidMeta: raidMeta || null,
      editableByUser,
      displayMap,
      // Stored for the `raid` action handler to consume once the
      // per-raid snapshot is loaded. Only meaningful in scopeAll.
      preSelectedUserId: scopeAll ? preSelectedUserId : null,
      preSelectedDisplayName,
      selectedUser: null,
      selectedChar: null,
      // Specific-raid: locked at init to the combined map key
      // ("serca_hard"), preserved through every user/char re-pick.
      // ScopeAll: starts null; set when the raid dropdown fires a `raid`
      // action and reloads the snapshot for the picked raid.
      //
      // IMPORTANT: this is the combined map key, NOT raidMeta.raidKey
      // (just "serca"). RAID_REQUIREMENT_MAP is keyed by the combined
      // form; misusing the object field would make every downstream
      // RAID_REQUIREMENT_MAP lookup (embed render, status-button guard,
      // applyEditAndConfirm) return undefined and silently no-op the
      // apply. This regression happened in 639ac03 / fixed in f8cd84a.
      selectedRaid: raidKey || null,
      awaitingGate: false,
      applied: false,
      locked: false,
      message: null,
      warning: null,
    };

    await interaction.editReply({
      embeds: [buildEditEmbed(state)],
      components: buildEditComponents(state),
    });
    const followup = await interaction.fetchReply();
    // scopeAll opens with raidMeta=null (the raid is picked inside the
    // UI), so log a sentinel instead of dereferencing raidMeta.raidKey.
    // Before this guard a TypeError fired between editReply and the
    // collector setup below, which meant the raid dropdown rendered
    // but had no handler to process clicks - a silent dead UI.
    // Caught by Codex review of commit e15b275.
    const openedRaidLabel = scopeAll
      ? "all"
      : `${raidMeta.raidKey}:${raidMeta.modeKey}`;
    console.log(
      `[raid-check edit] opened raid=${openedRaidLabel} users=${editableByUser.size} openMs=${Date.now() - started}`
    );

    const collector = followup.createMessageComponentCollector({
      time: RAID_CHECK_EDIT_SESSION_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        await component.reply({
          content: `${UI.icons.lock} Chỉ người mở Edit session mới thao tác được.`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }
      const parts = (component.customId || "").split(":");
      // parts[0] = "raid-check-edit", parts[1] = action, parts[2] = value (if any)
      const action = parts[1];

      if (action === "raid") {
        // Scope-all raid picker. Load the snapshot + editableByUser +
        // displayMap for the picked raid so the user/char cascade below
        // can render against real data. Ack immediately with deferUpdate
        // so Discord doesn't time out the 3-second interaction window
        // while computeRaidCheckSnapshot hits the DB.
        const pickedRaidKey = component.values[0];
        const pickedRaidMeta = RAID_REQUIREMENT_MAP[pickedRaidKey];
        if (!pickedRaidMeta) {
          state.warning = `${UI.icons.warn} Raid không hợp lệ.`;
          await component.update({
            embeds: [buildEditEmbed(state)],
            components: buildEditComponents(state),
          }).catch(() => {});
          return;
        }
        await component.deferUpdate().catch(() => {});
        try {
          const newSnapshot = await computeRaidCheckSnapshot(pickedRaidMeta);
          const newEditableByUser = buildEditableCharsByUser(newSnapshot);
          const newDisplayMap = new Map();
          await Promise.all(
            [...newEditableByUser.keys()].map(async (discordId) => {
              const meta = newSnapshot.userMeta.get(discordId) || {};
              const name = await resolveCachedDisplayName(
                interaction.client,
                discordId,
                meta
              );
              newDisplayMap.set(discordId, name);
            })
          );

          state.raidMeta = pickedRaidMeta;
          state.selectedRaid = pickedRaidKey;
          state.editableByUser = newEditableByUser;
          state.displayMap = newDisplayMap;
          // Changing raid invalidates any previously picked user/char -
          // a user who was editable for Serca Hard might have no char
          // eligible for Act 4 Normal at all.
          state.selectedUser = null;
          state.selectedChar = null;
          state.awaitingGate = false;
          state.warning = null;

          // Pre-select the user the leader was viewing on the source
          // all-mode page, IF they're still editable for the picked
          // raid. Consumed-once: clear the hint after applying so
          // subsequent raid re-picks use the leader's own explicit
          // user choice (or lack thereof) without re-pre-selecting.
          if (state.preSelectedUserId) {
            if (newEditableByUser.has(state.preSelectedUserId)) {
              state.selectedUser = state.preSelectedUserId;
            } else {
              // Pre-select dropped silently because the focused user
              // has no editable char for this raid (floor too high,
              // or all chars auto-sync + log on). Surface a warning
              // so the leader understands why User went from
              // "Du _(sẽ auto-pick...)_" back to "chưa chọn".
              const preName = state.preSelectedDisplayName || state.preSelectedUserId;
              state.warning = `${UI.icons.info} _${preName} không có char nào editable cho **${pickedRaidMeta.label}** - Artist đã bỏ pre-select. Chọn user khác từ dropdown nhé._`;
            }
          }
          state.preSelectedUserId = null;
          state.preSelectedDisplayName = null;
        } catch (err) {
          state.warning = `${UI.icons.warn} Load snapshot cho raid này fail: ${err?.message || String(err)}`;
          console.warn(`[raid-check edit scopeAll] raid-pick load failed:`, err?.message || err);
        }
        await interaction.editReply({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }

      if (action === "user") {
        state.selectedUser = component.values[0];
        state.selectedChar = null;
        // selectedRaid stays locked to raidMeta.raidKey (the raid the
        // leader opened /raid-check against) through every re-pick.
        state.awaitingGate = false;
        state.warning = null;
        await component.update({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }
      if (action === "char") {
        const group = state.editableByUser.get(state.selectedUser);
        const [accountName, charName] = (component.values[0] || "").split("||");
        const picked = (group?.chars || []).find(
          (c) => c.accountName === accountName && c.charName === charName
        );
        state.selectedChar = picked || null;
        state.awaitingGate = false;
        state.warning = null;
        await component.update({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }
      if (action === "status") {
        const statusType = parts[2];
        if (statusType === "process") {
          state.awaitingGate = true;
          state.warning = "Chọn gate cần đánh dấu Process.";
          await component.update({
            embeds: [buildEditEmbed(state)],
            components: buildEditComponents(state),
          }).catch(() => {});
          return;
        }
        // Complete / Reset: apply immediately.
        await applyEditAndConfirm(component, state, statusType, null);
        return;
      }
      if (action === "gate") {
        const gate = parts[2];
        await applyEditAndConfirm(component, state, "process", gate);
        return;
      }
      if (action === "cancel") {
        state.locked = true;
        await component.update({
          embeds: [EmbedBuilder.from(buildEditEmbed(state)).setFooter({ text: "Session đã đóng · mở lại bằng nút Edit trong /raid-check" })],
          components: buildEditComponents(state).map((row) => {
            for (const c of row.components) {
              if (typeof c.setDisabled === "function") c.setDisabled(true);
            }
            return row;
          }),
        }).catch(() => {});
        collector.stop("cancelled");
        return;
      }
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "cancelled" || state.applied) return;
      let refreshed = false;
      try {
        await interaction.editReply({
          embeds: [
            EmbedBuilder.from(buildEditEmbed(state)).setFooter({
              text: "Session đã hết hạn · mở lại bằng nút Edit trong /raid-check",
            }),
          ],
          components: buildEditComponents(state).map((row) => {
            for (const c of row.components) {
              if (typeof c.setDisabled === "function") c.setDisabled(true);
            }
            return row;
          }),
        });
        refreshed = true;
      } catch (err) {
        // Ephemeral followup interaction token has already expired (> 15 min
        // idle after deferReply). We can't edit that message any more, so
        // fall through to the public tag so the leader at least understands
        // why their last click did nothing.
        console.warn(`[raid-check edit] session-end edit failed:`, err?.message || err);
      }
      if (!refreshed) {
        await postEditSessionExpiredNotice(
          interaction,
          "Edit session `/raid-check` của cậu vừa hết hạn và Artist không update được UI ephemeral nữa. Gõ lại `/raid-check` rồi bấm ✏️ Edit để mở session mới nhé."
        );
      }
    });
  }

  /**
   * When the Edit flow's ephemeral follow-up can no longer be edited
   * (interaction token past the 15-minute window, Discord outage, etc.)
   * we lose the channel to talk back. Post a public-channel tag so the
   * leader sees a concrete "here's why that click did nothing" instead
   * of a silent UI. Best-effort + auto-delete so the channel doesn't
   * accumulate stale notices.
   */
  async function postEditSessionExpiredNotice(interaction, note) {
    const channel = interaction.channel;
    if (!channel || typeof channel.send !== "function") return;
    try {
      const sent = await channel.send({
        content: `<@${interaction.user.id}> ${note}`,
        allowedMentions: { users: [interaction.user.id] },
      });
      setTimeout(() => {
        sent.delete().catch(() => {});
      }, 30_000);
    } catch (err) {
      console.warn(
        `[raid-check edit] session-expired tag post failed:`,
        err?.message || err
      );
    }
  }

  /**
   * DM sent to the target member after a Raid Manager uses the Edit flow
   * to change their progress. Artist speaks in first-person: the specific
   * Raid Manager's identity is intentionally NOT surfaced (roles only, no
   * names) so the DM reads as a system notification from the bot, not a
   * finger-point at a particular leader. Best-effort: never blocks apply,
   * never re-tried on failure.
   */
  function buildRaidCheckEditDMEmbed({
    targetChar,
    raidMeta,
    statusType,
    gate,
    modeResetHappened,
  }) {
    const actionLine =
      statusType === "complete"
        ? "✅ Đánh dấu toàn bộ gate là done"
        : statusType === "reset"
          ? "🔄 Reset về 0, toàn bộ gate đã xoá sạch"
          : `📝 Đánh dấu **${gate || "gate"}** là done, các gate khác giữ nguyên`;
    const color =
      statusType === "reset" ? UI.colors.progress : UI.colors.success;
    const lines = [
      "Chào cậu~ Có Raid Manager vừa nhờ Artist chỉnh progress raid cho cậu một chút đây nha. Artist vừa làm việc này:",
      "",
      `**Character:** ${targetChar.charName} · ${Math.round(targetChar.itemLevel)}`,
      `**Raid:** ${raidMeta.label}`,
      `**Thay đổi:** ${actionLine}`,
    ];
    if (modeResetHappened) {
      lines.push("");
      lines.push(`${UI.icons.warn} _Mode cũ của raid này Artist đã wipe vì difficulty mới. Gate ở mode cũ không còn được count nữa nhé._`);
    }
    lines.push("");
    lines.push("Cậu ghé `/raid-status` xem full progress mới giúp Artist nha~");

    return new EmbedBuilder()
      .setColor(color)
      .setTitle(`${UI.icons.done} Artist vừa chỉnh progress raid giúp cậu`)
      .setDescription(lines.join("\n"))
      .setTimestamp();
  }

  async function applyEditAndConfirm(component, state, statusType, gate) {
    state.locked = true;
    // Freeze components visually while the apply is in-flight.
    await component.update({
      embeds: [buildEditEmbed(state)],
      components: buildEditComponents(state),
    }).catch(() => {});

    const raidKey = state.selectedRaid;
    const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
    const targetChar = state.selectedChar;
    const effectiveGates = statusType === "process" && gate ? [gate] : [];

    let result;
    try {
      result = await applyRaidSetForDiscordId({
        discordId: state.selectedUser,
        characterName: targetChar.charName,
        rosterName: targetChar.accountName,
        raidMeta,
        statusType,
        effectiveGates,
      });
    } catch (err) {
      state.locked = false;
      state.applied = false;
      state.warning = `${UI.icons.warn} Apply failed: ${err?.message || String(err)}`;
      await component.message.edit({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      }).catch(() => {});
      console.warn(`[raid-check edit] apply failed:`, err?.message || err);
      return;
    }

    if (result?.updated) {
      applyLocalRaidEditToChar(targetChar, raidMeta, statusType, effectiveGates);
    }
    state.applied = true;

    // DM the target member when their progress actually changed on disk.
    // Skip three cases: (1) no-op apply (result.updated false; nothing for
    // the target to hear about), (2) self-edit (leader edited their own
    // char; they already see the confirmation in the ephemeral UI), and
    // (3) write did not land (noRoster / matched===0 / ineligible - the
    // summary below handles those). The DM is Artist's voice with no
    // leader identity per Traine's rule.
    const isSelfEdit = state.selectedUser === component.user.id;
    const didApplyWrite =
      result?.updated === true &&
      !result?.noRoster &&
      result?.matched !== 0 &&
      !result?.ineligibleItemLevel;
    let dmOutcome = null; // "sent" | "failed" | "skipped-self" | null (not attempted)
    if (didApplyWrite && isSelfEdit) {
      dmOutcome = "skipped-self";
    } else if (didApplyWrite) {
      try {
        // Gate the REST fetch through discordUserLimiter (same limiter the
        // Sync DM path uses) to keep /raid-check consistent with Discord's
        // global rate ceiling. Single-user apply is low volume on its own,
        // but funneling every REST call through the same limiter means
        // burst-edit sessions do not race Sync DM traffic.
        const user = await discordUserLimiter.run(() =>
          component.client.users.fetch(state.selectedUser)
        );
        const dmChannel = await user.createDM();
        const dmEmbed = buildRaidCheckEditDMEmbed({
          targetChar,
          raidMeta,
          statusType,
          gate,
          modeResetHappened: result?.modeResetCount > 0,
        });
        await dmChannel.send({ embeds: [dmEmbed] });
        dmOutcome = "sent";
      } catch (err) {
        dmOutcome = "failed";
        console.warn(
          `[raid-check edit] DM to ${state.selectedUser} failed:`,
          err?.message || err
        );
      }
    }

    const summaryParts = [];
    const statusLabel =
      statusType === "complete" ? "Complete" :
      statusType === "reset" ? "Reset" :
      `Process ${gate || "?"}`;
    if (result?.noRoster) {
      summaryParts.push(`${UI.icons.warn} User chưa có roster nào.`);
    } else if (result?.matched === 0) {
      summaryParts.push(`${UI.icons.warn} Không tìm thấy char "${targetChar.charName}" trong roster.`);
    } else if (result?.ineligibleItemLevel) {
      summaryParts.push(`${UI.icons.warn} Char iLvl ${result.ineligibleItemLevel} chưa đủ cho ${raidMeta.label} (${raidMeta.minItemLevel}+).`);
    } else if (result?.alreadyComplete) {
      summaryParts.push(`${UI.icons.info} _Raid đã DONE sẵn cho **${targetChar.charName}** · ${raidMeta.label}, không có gì để update._`);
    } else if (result?.alreadyReset) {
      summaryParts.push(`${UI.icons.info} _Raid đã ở trạng thái reset sẵn cho **${targetChar.charName}** · ${raidMeta.label}, không có gì để xoá._`);
    } else {
      summaryParts.push(`${UI.icons.done} Đã apply **${statusLabel}** cho **${targetChar.charName}** · ${raidMeta.label}.`);
      if (result?.modeResetCount > 0) {
        summaryParts.push(`_Mode cũ đã bị wipe vì difficulty mới._`);
      }
    }
    if (dmOutcome === "sent") {
      summaryParts.push(`📨 _Đã DM báo member biết progress vừa thay đổi._`);
    } else if (dmOutcome === "failed") {
      summaryParts.push(`${UI.icons.warn} _DM cho member fail, có thể họ đã tắt DM from server members. Update vẫn vào DB rồi._`);
    } else if (dmOutcome === "skipped-self") {
      summaryParts.push(`_Bỏ qua DM vì cậu edit char của chính mình._`);
    }
    summaryParts.push("");
    summaryParts.push(`_Gõ lại \`/raid-check raid:${raidMeta.raidKey}_${normalizeName(raidMeta.modeKey)}\` để xem pending list mới._`);
    state.message = summaryParts.join("\n");

    let uiRefreshed = false;
    try {
      await component.message.edit({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      });
      uiRefreshed = true;
    } catch (err) {
      console.warn(
        `[raid-check edit] post-apply UI refresh failed:`,
        err?.message || err
      );
    }
    console.log(
      `[raid-check edit] applied user=${state.selectedUser} char=${targetChar.charName} raid=${raidKey} status=${statusType}${gate ? ` gate=${gate}` : ""}`
    );
    if (!uiRefreshed) {
      // Apply succeeded but we can't update the ephemeral UI. Surface a
      // public tag so the leader sees confirmation + knows to rerun.
      await postEditSessionExpiredNotice(
        component,
        `Apply **${statusLabel}** cho **${targetChar.charName}** · ${raidMeta.label} đã xong rồi, nhưng Artist không refresh được UI ephemeral. Gõ lại \`/raid-check\` để xem pending list mới.`
      );
    }
  }

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
  async function handleRaidCheckAllCommand(interaction) {
    if (!isRaidLeader(interaction)) {
      await interaction.reply({
        content: `${UI.icons.lock} Chỉ Raid Manager mới được dùng \`/raid-check\` (config qua env \`RAID_MANAGER_ID\`).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const started = Date.now();

    // Only users with at least one account matter for the overview.
    // Select enough identity fields to resolve an avatar-less fallback
    // display name (same cache-first preference the Edit flow uses).
    const users = await User.find({ "accounts.0": { $exists: true } })
      .select(
        "discordId accounts autoManageEnabled lastAutoManageSyncAt lastAutoManageAttemptAt discordUsername discordGlobalName discordDisplayName"
      )
      .lean();

    for (const userDoc of users) {
      ensureFreshWeek(userDoc);
    }

    // Each page = one (user, account) pair. Empty accounts (0 chars)
    // still render a blank page so the leader knows the slot exists
    // rather than have it silently disappear - same contract /raid-status
    // uses for its own caller's empty accounts.
    const pagesData = [];
    for (const userDoc of users) {
      const accounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
      for (let idx = 0; idx < accounts.length; idx += 1) {
        pagesData.push({ userDoc, account: accounts[idx], accountIdx: idx });
      }
    }

    if (pagesData.length === 0) {
      await interaction.editReply({
        content: `${UI.icons.info} Chưa có ai có roster nào cả. Bảo các member dùng \`/add-roster\` trước nhé~`,
      });
      return;
    }

    // Resolve Discord display name + avatar for each visible user once.
    // Cache-first on discord.js users cache, limiter-gated miss path
    // (same helper the existing /raid-check render already uses).
    const visibleUserIds = [...new Set(pagesData.map((p) => p.userDoc.discordId))];
    const authorMeta = new Map();
    await Promise.all(
      visibleUserIds.map(async (discordId) => {
        const userDoc = users.find((u) => u.discordId === discordId);
        const cachedDisplayName =
          userDoc?.discordDisplayName ||
          userDoc?.discordGlobalName ||
          userDoc?.discordUsername ||
          "";
        let displayName = cachedDisplayName || discordId;
        let avatarURL = null;
        try {
          let userObj = interaction.client.users.cache.get(discordId);
          if (!userObj) {
            userObj = await discordUserLimiter.run(() =>
              interaction.client.users.fetch(discordId)
            );
          }
          if (userObj) {
            avatarURL = userObj.displayAvatarURL({ size: 64 });
            if (!cachedDisplayName) {
              displayName = userObj.username || displayName;
            }
          }
        } catch {
          // Fallback to cached name / snowflake; avatar stays null.
        }
        authorMeta.set(discordId, { displayName, avatarURL });
      })
    );

    const totalPages = pagesData.length;

    // User filter state. Starts as null (show all users). When a user
    // is picked from the filter dropdown, filteredIndices shrinks to
    // just that user's accounts (absolute indices into pagesData),
    // and currentLocalPage is the index INTO filteredIndices. Mirrors
    // the filter on specific-raid /raid-check but with accounts as
    // the unit instead of char-pages.
    const FILTER_ALL = "__all__";
    let filterUserId = null;
    let filteredIndices = pagesData.map((_, i) => i);
    let currentLocalPage = 0;

    const applyUserFilter = (pickedValue) => {
      filterUserId = pickedValue === FILTER_ALL ? null : pickedValue;
      if (filterUserId === null) {
        filteredIndices = pagesData.map((_, i) => i);
      } else {
        filteredIndices = [];
        for (let i = 0; i < pagesData.length; i += 1) {
          if (pagesData[i].userDoc.discordId === filterUserId) {
            filteredIndices.push(i);
          }
        }
      }
      // Reset to first page of the filtered subset; the previously
      // viewed absolute page may be outside the new filter.
      currentLocalPage = 0;
    };

    const buildPage = (pageIndex) => {
      const { userDoc, account } = pagesData[pageIndex];
      // Per-user raids cache. Lives inside buildPage so it rebuilds
      // per render - cheap, and keeps stale computed entries from
      // persisting if userDoc state changes in-session (it does not,
      // but the defensive reset keeps this identical to /raid-status
      // where raidsCache is per-command invocation).
      const raidsCache = new Map();
      const getRaidsFor = (character) => {
        let result = raidsCache.get(character);
        if (!result) {
          result = getStatusRaidsForCharacter(character);
          raidsCache.set(character, result);
        }
        return result;
      };

      const userAccounts = Array.isArray(userDoc.accounts) ? userDoc.accounts : [];
      const userTotalChars = userAccounts.reduce(
        (sum, a) => sum + (Array.isArray(a.characters) ? a.characters.length : 0),
        0
      );
      const allRaidEntries = [];
      for (const a of userAccounts) {
        for (const ch of a.characters || []) {
          allRaidEntries.push(...getRaidsFor(ch));
        }
      }
      // globalTotals in buildAccountPageEmbed is "this user's all-
      // accounts rollup" - that's what /raid-status uses for its
      // single-user case too. For all-mode, the outer page X/Y is
      // cross-user so this rollup stays user-scoped.
      const globalTotals = {
        characters: userTotalChars,
        progress: summarizeRaidProgress(allRaidEntries),
      };

      const userMeta = {
        discordId: userDoc.discordId,
        autoManageEnabled: !!userDoc.autoManageEnabled,
        lastAutoManageSyncAt: Number(userDoc.lastAutoManageSyncAt) || 0,
        lastAutoManageAttemptAt: Number(userDoc.lastAutoManageAttemptAt) || 0,
      };

      // Pass totalPages=1 so buildAccountPageEmbed's title does NOT
      // emit its own within-user " · Page X/Y" suffix. Account name
      // already identifies which account this is; emitting two "Page"
      // markers reads as double-paginated and confuses the leader.
      // The page counter moves to the author line below where it sits
      // next to the Discord display name per Traine's ask.
      //
      // CAVEAT: in /raid-status, `totalPages > 1` is dual-purpose - it
      // gates BOTH the title page counter AND the "🌐 All accounts"
      // cross-account rollup line. Passing totalPages=1 here suppresses
      // the rollup line unintentionally, so we re-inject it manually
      // below. The rollup is important for all-mode because a user's
      // per-account "2/16 raids done" without context doesn't tell the
      // leader whether that's the user's only account or one of five.
      const accountPageIdx = 0;
      const embed = buildAccountPageEmbed(
        account,
        accountPageIdx,
        1,
        globalTotals,
        getRaidsFor,
        userMeta
      );

      // Re-inject the cross-account rollup line that buildAccountPageEmbed
      // suppressed when we passed totalPages=1. Same copy it uses so the
      // surface stays consistent with /raid-status.
      if (userAccounts.length > 1) {
        const rollupLine = `\n🌐 All accounts: **${globalTotals.characters}** chars · **${globalTotals.progress.completed}/${globalTotals.progress.total}** raids done`;
        const baseDescription = embed.data?.description || "";
        // Insert the rollup right after the first line (account-level
        // progress summary) and before the freshness line, matching
        // /raid-status's visual order: account → global → freshness.
        const lines = baseDescription.split("\n");
        if (lines.length >= 2) {
          lines.splice(1, 0, rollupLine.trimStart());
          embed.setDescription(lines.join("\n"));
        } else {
          embed.setDescription(baseDescription + rollupLine);
        }
      }

      // Overlay a setAuthor with Discord avatar + display name. Append
      // cross-user "Page X/Y" to the right of the name per Traine's
      // ask - Discord author.name is a single string with no right-
      // align option, so concatenation is the only way to put the
      // counter next to the user. 256-char cap leaves plenty of room.
      //
      // Page counter adapts to the filter state: when a user filter
      // is active, show filtered "Page 2/3" (local to that user's
      // accounts) instead of the absolute cross-user index, since
      // the leader cares about "where am I in Du's accounts" not
      // "which global page this is" once they've focused on someone.
      const meta = authorMeta.get(userDoc.discordId);
      if (meta) {
        let pageSuffix = "";
        if (filterUserId === null) {
          if (totalPages > 1) {
            pageSuffix = ` · Page ${pageIndex + 1}/${totalPages}`;
          }
        } else {
          const localTotal = filteredIndices.length;
          if (localTotal > 1) {
            pageSuffix = ` · Page ${currentLocalPage + 1}/${localTotal}`;
          }
        }
        const authorPayload = {
          name: truncateText(`${meta.displayName}${pageSuffix}`, 256),
        };
        if (meta.avatarURL) authorPayload.iconURL = meta.avatarURL;
        embed.setAuthor(authorPayload);
      }

      return embed;
    };

    const buildButtonRow = (disabled) => {
      const localTotal = filteredIndices.length;
      const row = buildPaginationRow(currentLocalPage, localTotal, disabled, {
        prevId: "raid-check-all-page:prev",
        nextId: "raid-check-all-page:next",
      });
      // Append the cross-raid Edit button. customId encodes the
      // discordId of the user currently shown on this page so the
      // Edit flow can pre-select them after the leader picks a raid.
      // Per Traine: clicking Edit while viewing Bao's page should
      // target Bao, not force re-picking from a fresh dropdown.
      // `raid-check:edit-all:<discordId>` is still routed by bot.js's
      // global dispatcher (matches the `raid-check:*` prefix) and
      // handleRaidCheckButton splits parts[2] out as the pre-select.
      const currentAbs = currentAbsoluteIndex();
      const currentViewUserId =
        pagesData[currentAbs]?.userDoc?.discordId || "";
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`raid-check:edit-all:${currentViewUserId}`)
          .setLabel("Edit progress")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      );
      return row;
    };

    // User filter dropdown. Mirrors specific-raid /raid-check's
    // "All users / Filter theo user" picker so a leader in all-mode
    // can jump straight to a specific member without clicking Next
    // through everyone. Discord StringSelect caps at 25 options so
    // slice the per-user list at 24 (plus the All-users entry).
    // With 24+ users in the guild, the overflow users won't appear
    // in the dropdown but are still reachable via Prev/Next.
    const buildFilterRow = (disabled) => {
      const options = [
        {
          label: truncateText(`All users (${pagesData.length} pages)`, 100),
          value: FILTER_ALL,
          emoji: "🌐",
          default: filterUserId === null,
        },
      ];
      const sortedUsers = visibleUserIds
        .map((discordId) => {
          let accountsCount = 0;
          for (const p of pagesData) {
            if (p.userDoc.discordId === discordId) accountsCount += 1;
          }
          return {
            discordId,
            accountsCount,
            displayName: authorMeta.get(discordId)?.displayName || discordId,
          };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      for (const u of sortedUsers.slice(0, 24)) {
        options.push({
          label: truncateText(
            `${u.displayName} (${u.accountsCount} acc${u.accountsCount === 1 ? "" : "s"})`,
            100
          ),
          value: u.discordId,
          emoji: "👤",
          default: filterUserId === u.discordId,
        });
      }
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("raid-check-all-filter:user")
          .setPlaceholder("Jump to user / Lọc theo user...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    const buildComponents = (disabled) => [
      buildButtonRow(disabled),
      buildFilterRow(disabled),
    ];

    const currentAbsoluteIndex = () =>
      filteredIndices[currentLocalPage] ?? filteredIndices[0] ?? 0;

    await interaction.editReply({
      embeds: [buildPage(currentAbsoluteIndex())],
      components: buildComponents(false),
    });
    const followup = await interaction.fetchReply();
    console.log(
      `[raid-check all] rendered pages=${totalPages} users=${visibleUserIds.length} openMs=${Date.now() - started}`
    );

    const collector = followup.createMessageComponentCollector({
      time: RAID_CHECK_PAGINATION_SESSION_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        // Only reply-lock on components we own; a stray click on some
        // other bot's component shouldn't get a scolding message.
        const customId = component.customId || "";
        const ours =
          customId.startsWith("raid-check-all-page:") ||
          customId === "raid-check-all-filter:user";
        if (ours) {
          await component
            .reply({
              content: `${UI.icons.lock} Chỉ người mở /raid-check mới bấm được.`,
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
        return;
      }
      const customId = component.customId || "";

      if (customId === "raid-check-all-filter:user") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : FILTER_ALL;
        applyUserFilter(value);
        await component
          .update({
            embeds: [buildPage(currentAbsoluteIndex())],
            components: buildComponents(false),
          })
          .catch(() => {});
        return;
      }

      if (customId.startsWith("raid-check-all-page:")) {
        const action = customId.split(":")[1];
        const localTotal = filteredIndices.length;
        if (action === "prev") currentLocalPage = Math.max(0, currentLocalPage - 1);
        else if (action === "next") currentLocalPage = Math.min(localTotal - 1, currentLocalPage + 1);
        else return;
        await component
          .update({
            embeds: [buildPage(currentAbsoluteIndex())],
            components: buildComponents(false),
          })
          .catch(() => {});
        return;
      }

      // raid-check:edit-all + other non-owned components fall through
      // to the bot.js global dispatcher.
    });

    collector.on("end", async () => {
      await followup
        .edit({ components: buildComponents(true) })
        .catch(() => {});
    });
  }

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
