const { createRaidStatusView } = require("./raid-status/view");
const { createRaidStatusTaskUi } = require("./raid-status/task-ui");
const { createRaidStatusSync } = require("./raid-status/sync");
const {
  FILTER_ALL_RAIDS,
  buildRaidDropdownState,
  buildRaidFilterRow,
} = require("./raid-status/raid-filter");
const {
  parseTaskToggleValue,
  toggleBulkSideTask,
  toggleSingleSideTask,
  toggleSharedTask,
} = require("./raid-status/task-actions");
const {
  buildNoticeEmbed,
} = require("../utils/raid/shared");
const {
  getNextSharedTaskTransitionMs,
} = require("../utils/raid/shared-tasks");
const { getAccessibleAccounts } = require("../services/access-control");

// Build a render-ready accounts array: caller's own subdocs PLUS shared
// accounts pulled from manager-A User docs via the access-control
// helper. Shared subdocs are converted to plain objects (so the local
// _sharedFrom badge field doesn't risk Mongoose validation if anything
// tries to save the merged array later) and stamped with the metadata
// the view layer reads to render the "shared by" badge on the page
// title and freshness line.
async function buildMergedAccounts(viewerDiscordId, ownAccounts) {
  const merged = Array.isArray(ownAccounts) ? ownAccounts.slice() : [];

  let accessible;
  try {
    accessible = await getAccessibleAccounts(viewerDiscordId);
  } catch (err) {
    console.warn("[raid-status] getAccessibleAccounts failed:", err.message);
    return merged;
  }

  for (const entry of accessible) {
    if (entry.isOwn) continue;
    const sourceAccount = entry.account;
    const plainAccount = sourceAccount && typeof sourceAccount.toObject === "function"
      ? sourceAccount.toObject({ depopulate: true })
      : { ...sourceAccount };
    plainAccount._sharedFrom = {
      ownerDiscordId: entry.ownerDiscordId,
      ownerLabel: entry.ownerLabel,
      accessLevel: entry.accessLevel,
    };
    merged.push(plainAccount);
  }

  return merged;
}

const STATUS_PAGINATION_SESSION_MS = 5 * 60 * 1000;
const STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS = 2500;
const STATUS_TASK_AUTO_REFRESH_GRACE_MS = 1000;

function createRaidStatusCommand(deps) {
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
    getCharacterName,
    truncateText,
    formatNextCooldownRemaining,
    waitWithBudget,
    summarizeRaidProgress,
    summarizeAccountGold,
    summarizeGlobalGold,
    formatGold,
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
    getRosterRefreshCooldownMs,
    isManagerId,
  } = deps;

  const {
    buildAccountFreshnessLine,
    buildAccountPageEmbed,
    buildStatusFooterText,
  } = createRaidStatusView({
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
  });

  const {
    buildStatusUserMeta,
    loadStatusUserDoc,
    runManualStatusSync,
  } = createRaidStatusSync({
    User,
    saveWithRetry,
    ensureFreshWeek,
    collectStaleAccountRefreshes,
    applyStaleAccountRefreshes,
    waitWithBudget,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    applyAutoManageCollectedForStatus,
    stampAutoManageAttempt,
    weekResetStartMs,
    STATUS_AUTO_MANAGE_PIGGYBACK_BUDGET_MS,
  });

  async function handleStatusCommand(interaction) {
    const discordId = interaction.user.id;
    const seedDoc = await User.findOne({ discordId });
    const hasOwnAccounts =
      seedDoc && Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;

    // Zero-own viewer support: a Discord user with no `/add-roster`
    // entries of their own can still see /raid-status if a Manager A
    // has run /raid-share grant target:them. Skip the early-exit for
    // the no-own-roster case when there's at least one accessible
    // share, and let the merged-accounts flow downstream surface A's
    // rosters as the entire view.
    let hasIncomingShare = false;
    if (!hasOwnAccounts) {
      try {
        const accessible = await getAccessibleAccounts(discordId);
        hasIncomingShare = accessible.some((entry) => !entry.isOwn);
      } catch (err) {
        console.warn(
          "[raid-status] share check failed during zero-own gate:",
          err?.message || err,
        );
      }
    }

    if (!hasOwnAccounts && !hasIncomingShare) {
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

    // Skip the refresh-userDoc dance for the share-only viewer: there's
    // no own roster to refresh, and loadStatusUserDoc assumes the doc
    // has at least one account it can iterate. Synthesize a minimal
    // stub doc so downstream readers (buildStatusUserMeta, raid-filter
    // aggregate, etc.) can use viewer-scoped fields without NPE.
    let userDoc;
    let piggybackOutcome = null;
    if (hasOwnAccounts) {
      const refreshed = await loadStatusUserDoc(discordId, seedDoc);
      userDoc = refreshed.userDoc;
      piggybackOutcome = refreshed.piggybackOutcome;
    } else {
      userDoc = seedDoc || { discordId, accounts: [] };
    }

    if (!hasIncomingShare && (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0)) {
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

    // Merge in accounts shared from manager-A users (RAID_MANAGER_ID
    // allowlist) so /raid-status renders both B's own rosters AND any
    // rosters A has granted to B via /raid-share grant. Shared accounts
    // carry an `_sharedFrom` tag the view layer reads to badge the page
    // title with "Shared by Alice" and skip auto-manage badges B has no
    // control over.
    let accounts = await buildMergedAccounts(discordId, userDoc.accounts);
    const totalCharacters = accounts.reduce(
      (sum, account) => sum + (Array.isArray(account.characters) ? account.characters.length : 0),
      0
    );

    let statusUserMeta = buildStatusUserMeta(userDoc, piggybackOutcome);

    // Raid-filter aggregate for the caller's own roster. Parallel to the
    // all-mode dropdown in /raid-check, but counts here are
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
    let {
      raidDropdownEntries,
      totalRaidPending,
    } = buildRaidDropdownState(accounts, baseGetRaidsFor);

    // Repopulates raidAggregate / raidDropdownEntries / totalRaidPending
    // from the current `accounts` array. Called after the Sync button
    // reloads userDoc so the per-raid dropdown counts reflect any newly-
    // applied gates.
    const recomputeRaidAggregate = () => {
      const nextState = buildRaidDropdownState(accounts, baseGetRaidsFor);
      raidDropdownEntries = nextState.raidDropdownEntries;
      totalRaidPending = nextState.totalRaidPending;
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

    const {
      ALL_CHARS_SENTINEL,
      buildTaskViewEmbed,
      buildViewToggleRow,
      buildSharedTaskToggleRow,
      buildTaskCharFilterRow,
      buildTaskToggleRow,
    } = createRaidStatusTaskUi({
      EmbedBuilder,
      ActionRowBuilder,
      StringSelectMenuBuilder,
      UI,
      getCharacterName,
      truncateText,
      getAccounts: () => accounts,
      getCurrentPage: () => currentPage,
      getCurrentView: () => currentView,
      getTaskCharFilter: (page) => taskCharFilterByPage.get(page),
    });

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
      // Cross-account gold tail on the 🌐 line uses summarizeGlobalGold,
      // which inherits the active raid filter via the same getRaidsFor
      // closure - so picking a single raid narrows the cross-account
      // gold sum in lockstep with the chars/raids-done tail.
      const filteredTotals = {
        characters: totalCharacters,
        progress: summarizeRaidProgress(filteredEntries),
        gold: summarizeGlobalGold(accounts, getRaidsFor),
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

    const buildComponents = (disabled) => {
      const rows = [];
      // Hide the Sync button when the page being viewed is a shared
      // roster (Manager A's roster surfaced via /raid-share grant). The
      // sync action runs against the viewer's own auto-manage record;
      // firing it from A's page would refresh B's stuff but not A's,
      // confusing the viewer. Owner A still gets the button on their
      // own /raid-status. UX: only B's own pages show Sync, so the
      // button's behavior matches its label.
      const currentAccount = accounts[currentPage];
      const currentPageIsShared = !!currentAccount?._sharedFrom;
      const showSync = statusUserMeta.autoManageEnabled && !currentPageIsShared;
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
        const sharedTaskRow = buildSharedTaskToggleRow(disabled);
        if (sharedTaskRow) rows.push(sharedTaskRow);
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
        rows.push(buildRaidFilterRow({
          ActionRowBuilder,
          StringSelectMenuBuilder,
          truncateText,
          raidDropdownEntries,
          totalRaidPending,
          filterRaidId,
          disabled,
        }));
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
    const editDrivenComponentIds = new Set([
      "status:prev",
      "status:next",
      "status-filter:raid",
      "status-view:toggle",
      "status-task:char-filter",
      "status-task:shared-toggle",
      "status-task:toggle",
    ]);
    const sessionExpiresAtMs = Date.now() + STATUS_PAGINATION_SESSION_MS;
    let collectorEnded = false;
    let taskAutoRefreshTimer = null;

    const clearTaskAutoRefresh = () => {
      if (taskAutoRefreshTimer) {
        clearTimeout(taskAutoRefreshTimer);
        taskAutoRefreshTimer = null;
      }
    };

    const scheduleTaskAutoRefresh = () => {
      clearTaskAutoRefresh();
      if (collectorEnded || currentView !== "task") return;

      const nextTransitionMs = getNextSharedTaskTransitionMs(
        accounts[currentPage],
        new Date()
      );
      if (!nextTransitionMs) return;

      const fireAtMs = nextTransitionMs + STATUS_TASK_AUTO_REFRESH_GRACE_MS;
      if (fireAtMs >= sessionExpiresAtMs) return;

      const delayMs = Math.max(
        STATUS_TASK_AUTO_REFRESH_GRACE_MS,
        fireAtMs - Date.now()
      );
      taskAutoRefreshTimer = setTimeout(async () => {
        taskAutoRefreshTimer = null;
        if (collectorEnded || currentView !== "task") return;
        try {
          await interaction.editReply({
            embeds: [buildCurrentEmbed()],
            components: buildComponents(false),
          });
        } catch (err) {
          console.warn("[raid-status task auto-refresh] edit failed:", err?.message || err);
          return;
        }
        scheduleTaskAutoRefresh();
      }, delayMs);
    };

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
      if (editDrivenComponentIds.has(id)) {
        const deferred = await component.deferUpdate().then(() => true).catch((err) => {
          console.warn("[raid-status component] defer failed:", err?.message || err);
          return false;
        });
        if (!deferred) return;
      }

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
        const manualResult = await runManualStatusSync(discordId, {
          onAcquired: () => component.deferUpdate().catch(() => {}),
        });
        const manualOutcome = manualResult.outcome;
        if (manualResult.status === "cooldown") {
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

        // Reload userDoc fresh + recompute everything dependent on it.
        // The raidsCache holds per-character refs; .clear() invalidates
        // entries pointing at the old (pre-reload) character objects so
        // baseGetRaidsFor recomputes against the new accounts array.
        const reloaded = manualResult.userDoc;
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
      } else if (id === "status-task:shared-toggle" || id === "status-task:toggle") {
        const value =
          Array.isArray(component.values) && component.values.length > 0
            ? component.values[0]
            : "";
        const parsed = parseTaskToggleValue(value);
        if (parsed.kind === "noop" || parsed.kind === "invalid") {
          return;
        }

        const targetAccount = accounts[currentPage];
        const targetAccountName = targetAccount?.accountName || "";
        if (!targetAccountName) {
          return;
        }

        // Share-aware target: when the current page is a shared roster
        // (rendered via `_sharedFrom`), the toggle write should mutate
        // the OWNER's User doc, not B's. View-level shares cannot
        // toggle (the share doesn't grant write access); the toggle is
        // silently no-op'd with an audit log so the embed redraws
        // unchanged. Edit-level shares route the write to A's
        // discordId; the toggle helpers load and save A's User doc
        // unchanged.
        const sharedFrom = targetAccount?._sharedFrom;
        if (sharedFrom && sharedFrom.accessLevel !== "edit") {
          console.log(
            `[raid-status side-task toggle] view-only share rejected ` +
            `executor=${discordId} owner=${sharedFrom.ownerDiscordId} kind=${parsed.kind}`,
          );
          return;
        }
        const writeDiscordId = sharedFrom ? sharedFrom.ownerDiscordId : discordId;
        if (sharedFrom) {
          console.log(
            `[raid-status side-task toggle] share-write executor=${discordId} ` +
            `owner=${writeDiscordId} kind=${parsed.kind}`,
          );
        }

        if (parsed.kind === "shared") {
          try {
            await toggleSharedTask({
              User,
              saveWithRetry,
              discordId: writeDiscordId,
              targetAccountName,
              taskId: parsed.taskId,
            });
          } catch (err) {
            console.error(
              "[raid-status shared-task toggle] save failed:",
              err?.message || err
            );
          }
        } else if (parsed.kind === "bulk") {
          try {
            await toggleBulkSideTask({
              User,
              saveWithRetry,
              discordId: writeDiscordId,
              targetAccountName,
              targetReset: parsed.targetReset,
              targetNameLower: parsed.targetNameLower,
            });
          } catch (err) {
            console.error(
              "[raid-status side-task bulk-toggle] save failed:",
              err?.message || err
            );
          }
        } else if (parsed.kind === "single") {
          try {
            await toggleSingleSideTask({
              User,
              saveWithRetry,
              discordId: writeDiscordId,
              targetAccountName,
              targetCharName: parsed.targetCharName,
              targetTaskId: parsed.targetTaskId,
            });
          } catch (err) {
            console.error(
              "[raid-status side-task toggle] save failed:",
              err?.message || err
            );
          }
        }

        const reloaded = await User.findOne({ discordId }).lean();
        if (reloaded && Array.isArray(reloaded.accounts)) {
          userDoc = reloaded;
          accounts = userDoc.accounts;
        }
      } else {
        return;
      }

      const updated = await interaction.editReply({
        embeds: [buildCurrentEmbed()],
        components: buildComponents(false),
      }).then(() => true).catch((err) => {
        console.warn("[raid-status component] edit failed:", err?.message || err);
        return false;
      });
      if (updated) scheduleTaskAutoRefresh();
    });

    collector.on("end", async () => {
      collectorEnded = true;
      clearTaskAutoRefresh();
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
