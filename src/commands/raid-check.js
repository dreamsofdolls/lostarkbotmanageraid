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

          if (overallStatus === "none") {
            if (characterItemLevel < selfMin) {
              notEligibleChars.push({
                ...baseEntry,
                gateStatus: [],
                overallStatus: "not-eligible",
                notEligibleReason: "low",
              });
              continue;
            }
            if (characterItemLevel >= nextMin) {
              notEligibleChars.push({
                ...baseEntry,
                gateStatus: [],
                overallStatus: "not-eligible",
                notEligibleReason: "high",
              });
              continue;
            }
          }

          allEligible.push({
            ...baseEntry,
            gateStatus,
            overallStatus,
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
      return {
        name,
        value: truncateText(`${icon} ${doneCount}/${total}`, 1024),
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
      await handleRaidCheckEditClick(interaction, raidMeta);
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

  function formatCharEditLabel(char) {
    const suffix = char.autoManageEnabled && char.publicLogDisabled
      ? " · log off (manager only)"
      : "";
    return truncateText(
      `${char.charName} · ${Math.round(char.itemLevel)}${suffix}`,
      100
    );
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
    } else if (!state.selectedUser) {
      nextStep = "Pick **user** cần chỉnh progress trước nhé (dropdown ngay bên dưới).";
    } else if (!state.selectedChar) {
      nextStep = "Giờ chọn **character** trong roster của bạn đó.";
    } else if (!state.selectedRaid) {
      nextStep = "Chọn **raid + difficulty** cậu muốn update.";
    } else if (state.awaitingGate) {
      nextStep = "Pick **gate** (G1/G2) cho status Process - chỉ gate đó được đánh dấu done.";
    } else {
      nextStep = "Cuối cùng bấm **✅ Complete** (full raid), **📝 Process** (1 gate), hay **🔄 Reset** (xoá sạch).";
    }

    const userLabel = state.selectedUser
      ? state.displayMap.get(state.selectedUser) || state.selectedUser
      : "_chưa chọn_";
    const charLabel = state.selectedChar
      ? `${state.selectedChar.charName} · ${Math.round(state.selectedChar.itemLevel)}${state.selectedChar.publicLogDisabled ? " · 🔒 log off" : ""}`
      : "_chưa chọn_";
    const raidLabel = state.selectedRaid
      ? RAID_REQUIREMENT_MAP[state.selectedRaid]?.label || state.selectedRaid
      : "_chưa chọn_";

    const description = [
      "Artist dẫn cậu chỉnh progress giúp member nhé~ Chọn theo thứ tự **user → char → raid → status** thôi.",
      "",
      `🧍 **User:** ${userLabel}`,
      `⚔️ **Character:** ${charLabel}`,
      `🎯 **Raid:** ${raidLabel}`,
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

    // Row 1: user select. Always present so leader can re-pick.
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

    // Row 2: char select (only when user picked).
    if (state.selectedUser) {
      const group = state.editableByUser.get(state.selectedUser);
      const charOptions = (group?.chars || [])
        .slice(0, 25)
        .map((char) => ({
          label: formatCharEditLabel(char),
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

    // Row 3: raid select (only when char picked).
    if (state.selectedChar) {
      const raidOptions = getEligibleRaidsForChar(state.selectedChar.itemLevel)
        .slice(0, 25)
        .map(({ raidKey, entry }) => ({
          label: truncateText(`${entry.label} · ${entry.minItemLevel}+`, 100),
          value: raidKey,
          default: state.selectedRaid === raidKey,
        }));
      if (raidOptions.length > 0) {
        rows.push(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("raid-check-edit:raid")
              .setPlaceholder("Chọn raid + difficulty...")
              .setDisabled(disabled)
              .addOptions(raidOptions)
          )
        );
      }
    }

    // Row 4: status buttons (only when raid picked). Disable Complete
    // when the raid is already done at the picked mode (would be a
    // no-op server-side) and disable Process when there are no open
    // gates left to mark. Reset is always enabled - it's useful even
    // on a complete raid (e.g. undoing an accidental mark).
    if (state.selectedRaid) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = state.selectedChar
        ? getCharRaidGateStatus(state.selectedChar, raidMeta?.raidKey, raidMeta?.modeKey)
        : null;
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

    // Row 5: gate buttons (only when Process mode entered). Gate buttons
    // reflect current state: 🟢 emoji + disabled for gates already done
    // at the picked mode (re-marking would be a no-op), 🟠 for gates
    // done at a different mode (clicking triggers the mode-wipe path),
    // ⚪ for clean pending.
    if (state.selectedRaid && state.awaitingGate) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = state.selectedChar
        ? getCharRaidGateStatus(state.selectedChar, raidMeta?.raidKey, raidMeta?.modeKey)
        : { gates: [] };
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

  async function handleRaidCheckEditClick(interaction, raidMeta) {
    const started = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const snapshot = await computeRaidCheckSnapshot(raidMeta);
    const editableByUser = buildEditableCharsByUser(snapshot);

    if (editableByUser.size === 0) {
      await interaction.editReply({
        content: `${UI.icons.info} Không có char nào available để edit (raid floor ${raidMeta.minItemLevel}+ và không có char thuộc user đã tắt auto-sync hoặc có log off).`,
      });
      return;
    }

    // Resolve display names for just the editable users, via the shared
    // cache-first helper. See resolveCachedDisplayName for why we prefer the
    // User doc's cached identity over discord.js's own users cache.
    const displayMap = new Map();
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

    const state = {
      raidMeta,
      editableByUser,
      displayMap,
      selectedUser: null,
      selectedChar: null,
      selectedRaid: null,
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
    console.log(
      `[raid-check edit] opened raid=${raidMeta.raidKey}:${raidMeta.modeKey} users=${editableByUser.size} openMs=${Date.now() - started}`
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

      if (action === "user") {
        state.selectedUser = component.values[0];
        state.selectedChar = null;
        state.selectedRaid = null;
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
        state.selectedRaid = null;
        state.awaitingGate = false;
        state.warning = null;
        await component.update({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }
      if (action === "raid") {
        state.selectedRaid = component.values[0];
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
