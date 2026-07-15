/**
 * app/local-sync-web.js
 * Compose-root for the local-sync HTTP server. Wires the catalog +
 * raid-sync + roster + preview-summary endpoints into the
 * `apiHandlers` lookup table accepted by http-server.js, then starts
 * the server. LOCAL_SYNC_HTTP_DISABLED=true env opts out (useful when
 * running multiple bot instances and only one should host the
 * companion).
 */

"use strict";

const path = require("node:path");

const { startLocalSyncHttpServer } = require("../services/local-sync/http/server");
const { createRaidSyncEndpoint } = require("../services/local-sync/http/endpoints/sync-endpoint");
const { createRosterEndpoint } = require("../services/local-sync/http/endpoints/roster-endpoint");
const { createPreviewSummaryEndpoint } = require("../services/local-sync/http/endpoints/preview-summary-endpoint");
const { createCatalogEndpoint } = require("../services/local-sync/http/endpoints/catalog-endpoint");

/**
 * Build the `<METHOD> <pathname>` → handler map used by
 * startLocalSyncHttpServer's `apiHandlers` option. OPTIONS aliases are
 * registered alongside each verb so CORS preflight hits the same code
 * path.
 * @param {{User: object, applyRaidSetForDiscordId: function, applyRaidSetBatchForDiscordId: function}} deps
 * @returns {Object<string, Function>} handler map
 */
function createLocalSyncApiHandlers({
  User,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId,
  acquireAutoManageSyncSlot = null,
  releaseAutoManageSyncSlot = null,
}) {
  const raidSyncHandler = createRaidSyncEndpoint({
    User,
    applyRaidSetForDiscordId,
    applyRaidSetBatchForDiscordId,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
  });
  const rosterHandler = createRosterEndpoint({ User });
  const previewSummaryHandler = createPreviewSummaryEndpoint({ User });
  const catalogHandler = createCatalogEndpoint();

  return {
    "GET /api/local-sync/catalog": catalogHandler,
    "OPTIONS /api/local-sync/catalog": catalogHandler,
    "POST /api/raid-sync": raidSyncHandler,
    "OPTIONS /api/raid-sync": raidSyncHandler,
    "GET /api/me/roster": rosterHandler,
    "OPTIONS /api/me/roster": rosterHandler,
    "POST /api/local-sync/preview-summary": previewSummaryHandler,
    "OPTIONS /api/local-sync/preview-summary": previewSummaryHandler,
  };
}

/**
 * Starts the Local Sync web companion if enabled. This app-layer module owns
 * boot wiring only; the HTTP server and API handlers keep their own behavior.
 */
function startLocalSyncWebCompanion({
  rootDir,
  User,
  applyRaidSetForDiscordId,
  applyRaidSetBatchForDiscordId,
  acquireAutoManageSyncSlot = null,
  releaseAutoManageSyncSlot = null,
  env = process.env,
  log = console,
} = {}) {
  if (env.LOCAL_SYNC_HTTP_DISABLED === "true") {
    log.log("[bot] LOCAL_SYNC_HTTP_DISABLED=true - skipping web companion HTTP server.");
    return null;
  }

  try {
    return startLocalSyncHttpServer({
      webDir: path.join(rootDir, "web"),
      classIconsDir: path.join(rootDir, "assets", "class-icons"),
      apiHandlers: createLocalSyncApiHandlers({
        User,
        applyRaidSetForDiscordId,
        applyRaidSetBatchForDiscordId,
        acquireAutoManageSyncSlot,
        releaseAutoManageSyncSlot,
      }),
    });
  } catch (err) {
    log.error(
      "[bot] local-sync HTTP server failed to start (continuing without web companion):",
      err?.message || err
    );
    return null;
  }
}

module.exports = {
  createLocalSyncApiHandlers,
  startLocalSyncWebCompanion,
};
