"use strict";

const {
  subscribeLocalSyncApplied,
} = require("../../../services/local-sync/core/apply-events");
const {
  createLatestOnlyQueue,
} = require("../../../utils/async/latest-only-queue");

const LOCAL_SYNC_APPLY_RENDER_LABEL = "local-sync-apply";
const STATUS_OPEN_RENDER_LABEL = "open";
const SYNC_COMPLETED_RENDER_LABEL = "sync-completed";
const STATUS_STATE_REFRESH_LABELS = new Set([
  STATUS_OPEN_RENDER_LABEL,
  SYNC_COMPLETED_RENDER_LABEL,
  LOCAL_SYNC_APPLY_RENDER_LABEL,
]);
const MAX_STATUS_APPLY_OWNER_SUBSCRIPTIONS = 25;

function visibleRosterOwnerIds(viewerDiscordId, accounts) {
  const ids = [String(viewerDiscordId || "").trim()];
  for (const account of accounts || []) {
    ids.push(String(account?._sharedFrom?.ownerDiscordId || "").trim());
  }
  return [...new Set(ids.filter(Boolean))].slice(0, MAX_STATUS_APPLY_OWNER_SUBSCRIPTIONS);
}

/**
 * Coordinate background raid-status redraws and Local Reader apply events.
 * @param {object} deps
 * @param {string} deps.viewerDiscordId - Owner of the open status session.
 * @param {() => object[]} deps.getAccounts - Current own and shared roster pages.
 * @param {() => string} deps.getCurrentView - Current raid-status view key.
 * @param {() => boolean} deps.isSessionEnded - Whether the collector has ended.
 * @param {() => Promise<object>} deps.reloadViewerAccounts - Reload all visible rosters.
 * @param {() => void} deps.rebuildStatusUserMeta - Refresh own sync metadata from live state.
 * @param {(options: object) => Promise<object>} deps.refreshLocalSyncSnapshot - Load preview state.
 * @param {(snapshot: object) => void} deps.setLocalSyncSnapshot - Replace cached preview state.
 * @param {() => Promise<unknown>} deps.redrawMessage - Edit the open Discord message.
 * @param {(ids: string[], listener: Function, options: object) => Function} [deps.subscribe]
 * @param {object} [deps.log]
 * @returns {{request: (label?: string) => Promise<void>, flush: () => Promise<void>, start: () => void, stop: () => void}}
 */
function createRaidStatusLiveApplyRefresh({
  viewerDiscordId,
  getAccounts,
  getCurrentView,
  isSessionEnded,
  reloadViewerAccounts,
  rebuildStatusUserMeta,
  refreshLocalSyncSnapshot,
  setLocalSyncSnapshot,
  redrawMessage,
  subscribe = subscribeLocalSyncApplied,
  log = console,
}) {
  const viewerId = String(viewerDiscordId || "").trim();
  let stopped = false;
  let pendingOwnJobId = "";
  let unsubscribe = () => {};
  let subscribedOwnerKey = "";

  const queue = createLatestOnlyQueue(
    async (labels) => {
      if (stopped || isSessionEnded()) return;
      if (labels.some(label => STATUS_STATE_REFRESH_LABELS.has(label))) {
        const ownJobId = pendingOwnJobId;
        pendingOwnJobId = "";
        await reloadViewerAccounts();
        if (stopped || isSessionEnded()) return;
        rebuildStatusUserMeta();
        refreshSubscriptions();
        if (getCurrentView() === "sync" && (ownJobId || labels.includes(STATUS_OPEN_RENDER_LABEL))) {
          setLocalSyncSnapshot(await refreshLocalSyncSnapshot({ jobId: ownJobId }));
        }
      }
      if (!stopped && !isSessionEnded()) await redrawMessage();
    },
    {
      onError: (error, labels) => {
        log.warn(
          `[raid-status] ${labels.join("+") || "update"} background render failed:`,
          error?.message || error
        );
      },
    }
  );

  const onApplied = (event) => {
    if (stopped || isSessionEnded()) return;
    if (event.discordId === viewerId && event.jobId) {
      pendingOwnJobId = event.jobId;
    }
    void queue.request(LOCAL_SYNC_APPLY_RENDER_LABEL);
  };

  function refreshSubscriptions() {
    if (stopped || isSessionEnded()) return;
    const ownerIds = visibleRosterOwnerIds(viewerId, getAccounts());
    const ownerKey = ownerIds.join("\u0000");
    if (ownerKey === subscribedOwnerKey) return;
    unsubscribe();
    subscribedOwnerKey = ownerKey;
    unsubscribe = subscribe(ownerIds, onApplied, {
      onError: (error) => {
        log.warn("[raid-status] Local Reader apply listener failed:", error?.message || error);
      },
    });
  }

  function start() {
    refreshSubscriptions();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    unsubscribe = () => {};
    subscribedOwnerKey = "";
  }

  return {
    request: queue.request,
    flush: queue.flush,
    start,
    stop,
  };
}

module.exports = {
  STATUS_OPEN_RENDER_LABEL,
  SYNC_COMPLETED_RENDER_LABEL,
  createRaidStatusLiveApplyRefresh,
};
