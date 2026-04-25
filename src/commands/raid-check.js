const { createSnapshotHelpers } = require("./raid-check/snapshot");
const { createEditHelpers } = require("./raid-check/edit-helpers");
const { createAllModeHandler } = require("./raid-check/all-mode");

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

  const RAID_CHECK_EDIT_SESSION_MS = 3 * 60 * 1000;

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
