const { createSnapshotHelpers } = require("./raid-check/snapshot");
const { createEditHelpers } = require("./raid-check/edit-helpers");
const { createAllModeHandler } = require("./raid-check/all-mode");
const { createEditUi } = require("./raid-check/edit-ui");
const { createSyncUi } = require("./raid-check/sync-ui");

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
