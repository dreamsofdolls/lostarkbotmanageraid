"use strict";

const path = require("node:path");

const { startLocalSyncHttpServer } = require("../services/local-sync/http-server");
const { createRaidSyncEndpoint } = require("../services/local-sync/sync-endpoint");
const { createRosterEndpoint } = require("../services/local-sync/roster-endpoint");
const { createPreviewSummaryEndpoint } = require("../services/local-sync/preview-summary-endpoint");
const { createCatalogEndpoint } = require("../services/local-sync/catalog-endpoint");

function createLocalSyncApiHandlers({ User, applyRaidSetForDiscordId }) {
  const raidSyncHandler = createRaidSyncEndpoint({
    User,
    applyRaidSetForDiscordId,
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
      apiHandlers: createLocalSyncApiHandlers({ User, applyRaidSetForDiscordId }),
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
