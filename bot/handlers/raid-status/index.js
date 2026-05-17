const { createRaidStatusView } = require("./view");
const { createRaidStatusTaskUi } = require("./task-ui");
const { createRaidStatusSync } = require("./sync");
const { renderRaidStatusCard } = require("../../services/raid-card");
const { loadBackgroundBuffer } = require("../../services/raid-card/bg-loader");
const {
  FILTER_ALL_RAIDS,
  buildRaidDropdownState,
  buildRaidFilterRow,
} = require("./raid-filter");
const {
  parseTaskToggleValue,
  toggleBulkSideTask,
  toggleSingleSideTask,
  toggleSharedTask,
} = require("./task-actions");
const {
  buildNoticeEmbed,
} = require("../../utils/raid/common/shared");
const {
  getNextSharedTaskTransitionMs,
} = require("../../utils/raid/tasks/shared-tasks");
const { getAccessibleAccounts } = require("../../services/access/access-control");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  getOrMintLocalSyncToken,
  rotateLocalSyncToken,
  extractProfileFromUser,
} = require("../../services/local-sync");

// Build a render-ready accounts array: caller's own subdocs PLUS shared
// accounts pulled from manager-A User docs via the access-control
// helper. Shared subdocs are converted to plain objects (so the local
// _sharedFrom badge field doesn't risk Mongoose validation if anything
// tries to save the merged array later) and stamped with the metadata
// the view layer reads to render the "shared by" badge on the page
// title and freshness line.
async function buildMergedAccounts(viewerDiscordId, ownAccounts, { accessibleAccounts = null } = {}) {
  const merged = Array.isArray(ownAccounts) ? ownAccounts.slice() : [];

  let accessible;
  try {
    accessible = Array.isArray(accessibleAccounts)
      ? accessibleAccounts
      : await getAccessibleAccounts(viewerDiscordId, { includeOwn: false });
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

function resolveBackgroundLookup(viewerDiscordId, account) {
  const accountName = account?.accountName || "";
  const accountKey = String(accountName).trim().toLowerCase();
  return {
    discordId: viewerDiscordId,
    accountName,
    cacheKey: `${viewerDiscordId}:${accountKey}`,
  };
}

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
    // Probe localSyncEnabled BEFORE defer so we can flag the reply as
    // ephemeral when local-sync is on. The Mở Web Companion Link button
    // carries a signed token URL in its href - public messages would
    // leak that URL to anyone in the channel who clicks it (Link
    // buttons bypass bot auth). Ephemeral keeps the URL opener-only.
    // Lean+select is ~30ms - well under Discord's 3-sec defer deadline.
    let isLocalSyncMode = false;
    try {
      const probe = await User.findOne({ discordId })
        .select("localSyncEnabled")
        .lean();
      isLocalSyncMode = !!probe?.localSyncEnabled;
    } catch (err) {
      console.warn("[raid-status] localSync probe failed:", err?.message || err);
    }
    await interaction.deferReply(
      isLocalSyncMode ? { flags: MessageFlags.Ephemeral } : {}
    );
    // Resolve viewer's persistent language preference once at command
    // entry. Threads through every render path (early-exit notice,
    // buildAccountPageEmbed, freshness lines) so the whole interaction
    // renders monolingual. Falls back to default vi when no preference
    // is stored.
    const lang = await getUserLanguage(discordId, { UserModel: User });
    const seedDoc = await User.findOne({ discordId });
    const hasOwnAccounts =
      seedDoc && Array.isArray(seedDoc.accounts) && seedDoc.accounts.length > 0;

    // Zero-own viewer support: a Discord user with no `/raid-add-roster`
    // entries of their own can still see /raid-status if a Manager A
    // has run /raid-share grant target:them. Skip the early-exit for
    // the no-own-roster case when there's at least one accessible
    // share, and let the merged-accounts flow downstream surface A's
    // rosters as the entire view.
    let hasIncomingShare = false;
    let incomingSharedAccounts = null;
    if (!hasOwnAccounts) {
      try {
        incomingSharedAccounts = await getAccessibleAccounts(discordId, {
          includeOwn: false,
        });
        hasIncomingShare = incomingSharedAccounts.length > 0;
      } catch (err) {
        console.warn(
          "[raid-status] share check failed during zero-own gate:",
          err?.message || err,
        );
      }
    }

    if (!hasOwnAccounts && !hasIncomingShare) {
      await interaction.editReply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-status.notice.noRosterTitle", lang),
            description: t("raid-status.notice.noRosterDescription", lang),
          }),
        ],
      });
      return;
    }

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
            title: t("raid-status.notice.noRosterTitle", lang),
            description: t("raid-status.notice.noRosterDescription", lang),
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
    let accounts = await buildMergedAccounts(discordId, userDoc.accounts, {
      accessibleAccounts: incomingSharedAccounts,
    });
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

    const reloadViewerAccounts = async (nextOwnDoc = null) => {
      const reloadedOwnDoc = nextOwnDoc || await User.findOne({ discordId });
      if (reloadedOwnDoc && Array.isArray(reloadedOwnDoc.accounts)) {
        userDoc = reloadedOwnDoc;
      } else if (!userDoc || !Array.isArray(userDoc.accounts)) {
        userDoc = { discordId, accounts: [] };
      }

      accounts = await buildMergedAccounts(discordId, userDoc.accounts);
      raidsCache.clear();
      recomputeRaidAggregate();
      if (currentPage >= accounts.length) {
        currentPage = Math.max(0, accounts.length - 1);
      }
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
      lang,
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
    // Background buffer resolution is viewer-owned. Even when the current
    // page is a shared roster, the art comes from the person opening
    // /raid-status, not from the roster owner. null means "viewer never
    // opted in OR the lookup threw" · both collapse to "no canvas, just
    // embed". Cache the resolved buffer in a closure variable so pagination
    // + filter clicks inside the same handler reuse it without even paying
    // the bg-loader's updatedAt round-trip.
    const backgroundBufferCache = new Map();
    const resolveBackgroundBuffer = async (account) => {
      const lookup = resolveBackgroundLookup(discordId, account);
      const { cacheKey } = lookup;
      if (backgroundBufferCache.has(cacheKey)) return backgroundBufferCache.get(cacheKey);
      const buffer = await loadBackgroundBuffer(lookup.discordId, {
        accountName: lookup.accountName,
      });
      backgroundBufferCache.set(cacheKey, buffer);
      return buffer;
    };

    // Map the current page's account into the renderRaidStatusCard input
    // shape. Aggregates "raids cleared" across every eligible raid for
    // every character so the header badge surfaces a roster-level number
    // (matching the embed's per-row detail rolled up). Per-character
    // gate dots represent ONE dot per raid (cleared iff every sub-gate
    // of that raid is done) · keeps the canvas readable when characters
    // are eligible for 3-4 raids each. Embed below still carries the
    // per-gate breakdown for users who want the granular view.
    const buildCanvasInput = (account) => {
      if (!account?.characters?.length) return null;
      let aggregateCleared = 0;
      let aggregateTotal = 0;
      const canvasChars = [];
      for (const ch of account.characters) {
        const raids = baseGetRaidsFor(ch) || [];
        const gates = [];
        for (const raid of raids) {
          const subgates = Array.isArray(raid?.gates) ? raid.gates : [];
          const allDone =
            subgates.length > 0
            && subgates.every((g) => g?.completedDate || g?.cleared);
          aggregateTotal += 1;
          if (allDone) aggregateCleared += 1;
          gates.push({ cleared: allDone });
        }
        canvasChars.push({
          name: getCharacterName(ch),
          classId: ch.class || ch.className || "",
          itemLevel: Number(ch.itemLevel) || 0,
          gates,
        });
      }
      return {
        rosterName: account.accountName || "Roster",
        // No specific raid · the canvas headline summarises across every
        // eligible raid for this account. When raid-filter narrows the
        // view, a follow-up commit can swap this to the filtered raid's
        // name + icon.
        raid: { name: "Raid Status", icon: "⚔️", color: "#5865f2" },
        cleared: { count: aggregateCleared, total: aggregateTotal },
        characters: canvasChars,
      };
    };

    // Per-invocation canvas cache keyed by `${currentPage}` (the only
    // dimension that changes content within one command session ·
    // pagination + view toggle + filter clicks all flow through the
    // same handler scope). Pagination clicks land instant after the
    // first visit to each page · re-render only fires when the user
    // visits a page for the first time during this session.
    //
    // The cache is closure-scoped so it dies with the handler · we
    // never persist a buffer across invocations and never serve stale
    // data after the user does /raid-set elsewhere. 5-min collector
    // session means at most 5 minutes of stale buffer reuse, which is
    // shorter than the ~10 min refresh cooldown anyway.
    const canvasBufferCache = new Map();

    // Build the editReply payload with canvas attached when the user
    // opted into a background AND we're rendering the raid view. Task
    // view skips the canvas (no raid data to draw) and falls through
    // to embed-only. Render failures fall through too · the embed
    // still reaches the user.
    const buildEmbedAndCanvas = async () => {
      const embed = buildCurrentEmbed();
      const payload = { embeds: [embed], files: [], attachments: [] };
      const attachCanvasToEmbed = (buffer) => {
        const name = "raid-status.png";
        embed.setImage(`attachment://${name}`);
        payload.files = [{ attachment: buffer, name }];
        return payload;
      };
      if (currentView === "task") return payload;
      const account = accounts[currentPage];
      const bgBuffer = await resolveBackgroundBuffer(account);
      if (!bgBuffer) return payload;

      // TODO: include filterRaidId in cache key once buildCanvasInput
      // honors the filter (currently it aggregates every raid). For
      // now currentPage alone covers the cache hit rate for
      // pagination, which is the common click pattern.
      const cacheKey = String(currentPage);
      const cached = canvasBufferCache.get(cacheKey);
      if (cached) {
        return attachCanvasToEmbed(cached);
      }

      try {
        const canvasInput = buildCanvasInput(account);
        if (!canvasInput) return payload;
        const buffer = await renderRaidStatusCard({
          ...canvasInput,
          backgroundSource: bgBuffer,
        });
        canvasBufferCache.set(cacheKey, buffer);
        attachCanvasToEmbed(buffer);
      } catch (err) {
        console.warn("[raid-status] canvas render failed:", err?.message || err);
      }
      return payload;
    };

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
        { hideIneligibleChars: !!filterRaidId, lang }
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
        resolveCooldownMs(),
      );
      return remain
        ? t("raid-status.sync.buttonCooldown", lang, { remain })
        : t("raid-status.sync.buttonReady", lang);
    };

    // Phase 5 button-flip + Phase 7 resume/rotate: when the user is in
    // local-sync mode, replace the bible-driven "Sync ngay" Primary
    // button with an "Open Web Companion" Link button. The link URL
    // resolves through getOrMintLocalSyncToken so a returning user
    // keeps the same URL across multiple /raid-status calls within
    // the 15-min TTL (bookmarks + open tabs continue to work).
    //
    // A second "🆕 New link" Primary button rotates - clicked, mints
    // a fresh token, replies ephemerally with a fresh link button.
    // This is the explicit "I want a new URL" action; the resume
    // path is the default. Token resolution is async, so we cache
    // the resume URL in a closure variable populated at command
    // entry by hydrateLocalSyncResumeUrl() below; component builders
    // read it synchronously.
    let cachedLocalSyncResumeUrl = null;
    const buildLocalSyncResumeButton = (disabled = false) => {
      if (!cachedLocalSyncResumeUrl) return null;
      return new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(t("raid-status.sync.localOpenButtonLabel", lang))
        .setEmoji("🌐")
        .setURL(cachedLocalSyncResumeUrl)
        .setDisabled(disabled);
    };
    const buildLocalSyncNewButton = (disabled) => {
      if (!cachedLocalSyncResumeUrl) return null; // env unset or mint failed - hide both
      return new ButtonBuilder()
        .setCustomId("status:local-new-link")
        .setLabel(t("raid-status.sync.localNewLinkButtonLabel", lang))
        .setEmoji("🆕")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
    };
    // Refresh button: re-fetch userDoc from DB + re-render embed in
    // place. Useful right after the user syncs via web companion - they
    // can press this instead of re-typing /raid-status to see the new
    // progress. Local-sync only because bible mode has its own Sync
    // button which already re-fetches state on click.
    const buildLocalSyncRefreshButton = (disabled) => {
      return new ButtonBuilder()
        .setCustomId("status:local-refresh")
        .setLabel(t("raid-status.sync.localRefreshButtonLabel", lang))
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);
    };

    // Pre-fetch the resume URL at command entry. Async; main handler
    // awaits this before composing components. Returns the array of
    // buttons (1 or 2) so the row builder can splat them in. Empty
    // array when local mode but env unset = degraded deploy, hide.
    async function hydrateLocalSyncResumeUrl() {
      if (!statusUserMeta.localSyncEnabled) return;
      const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
      if (!baseUrl) return;
      try {
        const profile = extractProfileFromUser(interaction.user);
        const token = await getOrMintLocalSyncToken(discordId, lang, { UserModel: User, profile });
        cachedLocalSyncResumeUrl = `${baseUrl}/sync?token=${encodeURIComponent(token)}`;
      } catch (err) {
        console.warn("[raid-status] local-sync token resolve failed:", err?.message || err);
      }
    }
    await hydrateLocalSyncResumeUrl();

    const buildSyncButton = (disabled) => {
      // Local mode: returns the resume Link button. The "New link"
      // companion is added separately by buildSyncRow when applicable.
      // Pass disabled through so collector-end disables it (Link
      // buttons go straight to URL bypassing the bot, so without
      // setDisabled the post-session token URL would still be open
      // for anyone who clicks).
      if (statusUserMeta.localSyncEnabled) {
        return buildLocalSyncResumeButton(disabled);
      }
      return new ButtonBuilder()
        .setCustomId("status:sync")
        .setLabel(computeSyncLabel())
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled);
    };

    const buildSyncRow = (disabled) => {
      const btn = buildSyncButton(disabled);
      if (!btn) return null;
      const row = new ActionRowBuilder().addComponents(btn);
      // Local mode: append the "New link" + "Refresh" buttons alongside
      // resume so the user sees all 3 actions in the same row. Bible
      // mode just gets the single Sync button (unchanged behavior).
      // Total: [Resume][New link][Refresh] = 3 buttons, well under cap.
      if (statusUserMeta.localSyncEnabled) {
        const newBtn = buildLocalSyncNewButton(disabled);
        if (newBtn) row.addComponents(newBtn);
        row.addComponents(buildLocalSyncRefreshButton(disabled));
      }
      return row;
    };

    const buildComponents = (disabled) => {
      const rows = [];
      // Hide the Sync button when the page being viewed is a shared
      // roster (Manager A's roster surfaced via /raid-share grant). The
      // sync action runs against the viewer's own auto-manage record;
      // firing it from A's page would refresh B's stuff but not A's,
      // confusing the viewer. Owner A still gets the button on their
      // own /raid-status. UX: only B's own pages show Sync, so the
      // button's behavior matches its label.
      //
      // Phase 5: showSync flips on for EITHER mode (bible OR local),
      // since each renders its own button shape via buildSyncButton.
      const currentAccount = accounts[currentPage];
      const currentPageIsShared = !!currentAccount?._sharedFrom;
      const anySyncMode = statusUserMeta.autoManageEnabled || statusUserMeta.localSyncEnabled;
      const showSync = anySyncMode && !currentPageIsShared;
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
              lang,
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
          lang,
        });
        if (showSync) {
          // buildSyncButton returns null when local mode is enabled but
          // PUBLIC_BASE_URL/LOCAL_SYNC_TOKEN_SECRET env unset (degraded
          // deploy). Skip silently - the user will see no Sync button,
          // matches the autoManage-off case behaviorally.
          const btn = buildSyncButton(disabled);
          if (btn) paginationRow.addComponents(btn);
          // Local mode also gets "New link" + "Refresh" alongside resume.
          // ActionRow caps at 5; with [Prev][Next][Resume][New][Refresh]
          // = 5, exactly at the cap. Drop refresh from the inline row
          // when env-degraded (newBtn null = no companion link, so
          // refresh isn't useful either - the embed has nothing fresh
          // to show post-sync because there's no sync UI). Bible mode
          // adds nothing extra.
          if (statusUserMeta.localSyncEnabled) {
            const newBtn = buildLocalSyncNewButton(disabled);
            if (newBtn) {
              paginationRow.addComponents(newBtn);
              paginationRow.addComponents(buildLocalSyncRefreshButton(disabled));
            }
          }
        }
        rows.push(paginationRow);
      } else if (showSync) {
        // Single account: no pagination row to merge into, so Sync gets
        // its own dedicated row (otherwise the button would be missing
        // entirely for users with 1 roster).
        const row = buildSyncRow(disabled);
        if (row) rows.push(row);
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
          lang,
        }));
      }
      return rows;
    };

    const initialComponents = buildComponents(false);

    await interaction.editReply({
      ...(await buildEmbedAndCanvas()),
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
            ...(await buildEmbedAndCanvas()),
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
        // The rejection embed is delivered ephemerally to the CLICKER,
        // not the session opener - so it must render in the clicker's
        // own language. Resolving from interaction.user (the session
        // opener) would surface the warning in someone else's language
        // and only the clicker ever reads it. Cache hit makes this ~0ms.
        const clickerLang = await getUserLanguage(component.user.id, {
          UserModel: User,
        });
        await component.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: t("raid-status.sync.noControlTitle", clickerLang),
              description: t("raid-status.sync.noControlDescription", clickerLang),
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
      } else if (id === "status:local-new-link") {
        // Phase 7 rotation - in-place update flavor. Click flow:
        //   1. deferUpdate ack (gives 15-min window for the editReply)
        //   2. mint+save new token via rotateLocalSyncToken (Mongo write)
        //   3. push the fresh URL into cachedLocalSyncResumeUrl so the
        //      buildLocalSyncResumeButton closure picks it up
        //   4. editReply the ORIGINAL message - buttons in the same row
        //      now point at the new URL (no separate followup-with-link
        //      because the user already has the right button in front
        //      of them, just refreshed)
        //   5. ephemeral toast confirms the rotate happened (without
        //      it the click feels silent - button label/URL changed
        //      but the message visually looks identical)
        // Old token stays valid until its natural exp (30 min from
        // previous mint); rotation only decouples which URL the
        // "current" Resume button points at.
        const deferred = await component.deferUpdate().then(() => true).catch((err) => {
          console.warn("[raid-status] local-new-link defer failed:", err?.message || err);
          return false;
        });
        if (!deferred) return;
        const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
        if (!baseUrl) {
          await component.followUp({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "warn",
                title: t("raid-status.sync.localNewLinkUnavailableTitle", lang),
                description: t("raid-status.sync.localNewLinkUnavailableDescription", lang),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
          return;
        }
        let freshUrl;
        try {
          const profile = extractProfileFromUser(component.user);
          const token = await rotateLocalSyncToken(discordId, lang, { UserModel: User, profile });
          freshUrl = `${baseUrl}/sync?token=${encodeURIComponent(token)}`;
        } catch (err) {
          console.error("[raid-status] rotate local-sync token failed:", err?.message || err);
          await component.followUp({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "error",
                title: t("raid-status.sync.localNewLinkFailedTitle", lang),
                description: t("raid-status.sync.localNewLinkFailedDescription", lang, {
                  error: err?.message || String(err),
                }),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
          return;
        }
        cachedLocalSyncResumeUrl = freshUrl;
        // Re-render embed + components in place. buildLocalSyncResume
        // Button reads cachedLocalSyncResumeUrl - now pointing at the
        // fresh URL.
        await interaction.editReply({
          ...(await buildEmbedAndCanvas()),
          components: buildComponents(false),
        }).catch((err) => {
          console.warn("[raid-status] local-new-link editReply failed:", err?.message || err);
        });
        // Lightweight ephemeral toast - just a confirmation, no link
        // button since the in-message button already carries the new
        // URL right above this toast.
        await component.followUp({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "success",
              title: t("raid-status.sync.localNewLinkSuccessTitle", lang),
              description: t("raid-status.sync.localNewLinkSuccessDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      } else if (id === "status:local-refresh") {
        // Refresh button: re-fetch userDoc + accounts from DB so the
        // embed reflects post-web-sync state. Replaces "user re-types
        // /raid-status" with one click. Local-sync only (bible has
        // its own Sync button which already does this).
        const deferred = await component.deferUpdate().then(() => true).catch((err) => {
          console.warn("[raid-status] local-refresh defer failed:", err?.message || err);
          return false;
        });
        if (!deferred) return;
        try {
          await reloadViewerAccounts();
          // Re-read user-level flags too (autoManage/localSync state may
          // have flipped via /raid-auto-manage in another tab) - keeps
          // the badge logic consistent with the freshly-read doc.
          statusUserMeta = buildStatusUserMeta(userDoc, statusUserMeta?.piggybackOutcome || null);
        } catch (err) {
          console.error("[raid-status] local-refresh reload failed:", err?.message || err);
        }
        await interaction.editReply({
          ...(await buildEmbedAndCanvas()),
          components: buildComponents(false),
        }).catch((err) => {
          console.warn("[raid-status] local-refresh editReply failed:", err?.message || err);
        });
        // Ephemeral toast so the click feels acknowledged - the embed
        // re-render alone is silent if nothing visibly changed (e.g.
        // user clicked refresh before any sync happened).
        await component.followUp({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "success",
              title: t("raid-status.sync.localRefreshSuccessTitle", lang),
              description: t("raid-status.sync.localRefreshSuccessDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
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
                title: t("raid-status.sync.noAutoSyncTitle", lang),
                description: t("raid-status.sync.noAutoSyncDescription", lang),
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
            ) || t("raid-status.sync.cooldownFallback", lang);
          await component.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: t("raid-status.sync.cooldownTitle", lang),
                description: t("raid-status.sync.cooldownDescription", lang, { remain }),
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
          await reloadViewerAccounts(reloaded);
          statusUserMeta = buildStatusUserMeta(userDoc, manualOutcome);
        } else {
          // Doc disappeared somehow - just patch the outcome onto the
          // existing meta so the embed reflects the failed state.
          statusUserMeta = { ...statusUserMeta, piggybackOutcome: manualOutcome };
        }

        await interaction.editReply({
          ...(await buildEmbedAndCanvas()),
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
          followupCopy = t("raid-status.sync.followupApplied", lang, { n });
          followupType = "success";
        } else if (manualOutcome.outcome === "synced-no-new") {
          followupCopy = t("raid-status.sync.followupSyncedNoNew", lang);
          followupType = "info";
        } else if (manualOutcome.outcome === "failed") {
          followupCopy = t("raid-status.sync.followupFailedDescription", lang);
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
                      ? t("raid-status.sync.followupSuccessTitle", lang)
                      : followupType === "warn"
                        ? t("raid-status.sync.followupFailedTitle", lang)
                        : t("raid-status.sync.followupNeutralTitle", lang),
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

        await reloadViewerAccounts();
      } else {
        return;
      }

      const updated = await interaction.editReply({
        ...(await buildEmbedAndCanvas()),
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
        const expiredFooter = t("raid-status.expiredFooter", lang, {
          seconds: STATUS_PAGINATION_SESSION_MS / 1000,
        });
        const expiredEmbed = EmbedBuilder.from(buildCurrentEmbed()).setFooter({
          text: expiredFooter,
        });
        await interaction.editReply({
          embeds: [expiredEmbed],
          components: buildComponents(true),
          attachments: [],
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
  _resolveBackgroundLookup: resolveBackgroundLookup,
};
