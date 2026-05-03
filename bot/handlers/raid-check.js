const { createSnapshotHelpers } = require("./raid-check/snapshot");
const { createEditHelpers } = require("./raid-check/edit-helpers");
const { createAllModeHandler } = require("./raid-check/all-mode");
const { createEditUi } = require("./raid-check/edit-ui");
const { createSyncUi } = require("./raid-check/sync-ui");
const {
  createRaidCheckAutoManageUi,
  tryEnableAutoManage,
  tryDisableAutoManage,
  buildEnableAutoDmEmbed,
  buildDisableAutoDmEmbed,
} = require("./raid-check/auto-manage");
const { createTaskViewUi } = require("./raid-check/task-view-ui");
const { buildNoticeEmbed } = require("../utils/raid/shared");

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
    buildAccountPageEmbed,
    buildStatusFooterText,
    summarizeRaidProgress,
    getStatusRaidsForCharacter,
    buildPaginationRow,
    resolveDiscordDisplay,
    loadFreshUserSnapshotForRaidViews,
    shouldLoadFreshUserSnapshotForRaidViews,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    autoManageEntryKey,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    stampAutoManageAttempt,
    weekResetStartMs,
    isRaidLeader,
    isManagerId,
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
    shouldLoadFreshUserSnapshotForRaidViews,
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

  // /raid-check handler extracted to ./raid-check/all-mode.js.
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
    raidCheckRefreshLimiter,
    loadFreshUserSnapshotForRaidViews,
    shouldLoadFreshUserSnapshotForRaidViews,
    RAID_CHECK_USER_QUERY_FIELDS,
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

  const {
    handleRaidCheckEnableAutoOneClick,
    handleRaidCheckDisableAutoSelfClick,
    handleRaidCheckDisableAutoOneClick,
    handleRaidCheckEnableAutoSelfClick,
  } = createRaidCheckAutoManageUi({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    User,
    buildNoticeEmbed,
  });

  const { handleRaidCheckViewTasksClick } = createTaskViewUi({
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    truncateText,
    buildPaginationRow,
    RAID_CHECK_PAGINATION_SESSION_MS,
  });

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

    // Round-32: /raid-check is now a single entry point that always lands
    // in the cross-raid overview (all-mode). The previous per-raid render
    // path + open-time piggyback have been removed because the inline
    // raid-filter dropdown inside all-mode covers the same use case
    // without doubling command-line surface. Edit + Sync button flows
    // (which still need per-raid context) keep their dependencies via
    // computeRaidCheckSnapshot - that helper survived the cull because
    // it's reused by edit-ui.js and sync-ui.js for button-driven flows.
    await handleRaidCheckAllCommand(interaction);
  }

  async function handleRaidCheckButton(interaction) {
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const raidKey = parts[2];

    // Self-only actions bypass the Manager gate. Both ship as buttons
    // INSIDE DMs that the Manager sent to the target after the
    // on-behalf flow ran; the target (a regular member, not necessarily
    // a Manager) needs to be able to click these to revert the
    // Manager's action. Handler enforces clicker == target instead of
    // Manager allowlist.
    if (action === "disable-auto-self") {
      const targetDiscordId = parts[2] || null;
      await handleRaidCheckDisableAutoSelfClick(interaction, targetDiscordId);
      return;
    }
    if (action === "enable-auto-self") {
      const targetDiscordId = parts[2] || null;
      await handleRaidCheckEnableAutoSelfClick(interaction, targetDiscordId);
      return;
    }

    // Everything below requires Raid Manager.
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

    // enable-auto-one: customId is `raid-check:enable-auto-one:<discordId>`
    // (no raidKey, since flipping the auto-manage flag is raid-agnostic).
    // /raid-check button flows reach this
    // button when their user filter narrows to the target. Handle it before
    // the raidMeta gate below since parts[2] holds the discordId, not a
    // raidKey.
    if (action === "enable-auto-one") {
      const targetDiscordId = parts[2] || null;
      await handleRaidCheckEnableAutoOneClick(interaction, targetDiscordId);
      return;
    }
    if (action === "disable-auto-one") {
      const targetDiscordId = parts[2] || null;
      await handleRaidCheckDisableAutoOneClick(interaction, targetDiscordId);
      return;
    }

    // view-tasks: customId is `raid-check:view-tasks:<discordId>`. Read-
    // only Manager spot-check of a member's per-char side tasks. Lives
    // ONLY in /raid-check (the cross-raid overview button row
    // adds it) and only when user filter narrows to one user. Renders
    // an ephemeral followup so the embed dismisses on its own and
    // doesn't leak member task data into the raid-check pagination
    // session that other people in the channel can also see.
    if (action === "view-tasks") {
      const targetDiscordId = parts[2] || null;
      await handleRaidCheckViewTasksClick(interaction, targetDiscordId);
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
    handleRaidCheckEditClick,
    buildRaidCheckEditDMEmbed,
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
  tryEnableAutoManage,
  tryDisableAutoManage,
  buildEnableAutoDmEmbed,
  buildDisableAutoDmEmbed,
};
