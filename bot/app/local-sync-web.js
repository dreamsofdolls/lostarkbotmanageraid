/**
 * app/local-sync-web.js
 * Compose-root for the local-sync HTTP server. Wires the catalog +
 * roster + preview + Discord-handoff endpoints into the
 * `apiHandlers` lookup table accepted by http-server.js, then starts
 * the server. LOCAL_SYNC_HTTP_DISABLED=true env opts out (useful when
 * running multiple bot instances and only one should host the
 * Local Reader surface).
 */

"use strict";

const path = require("node:path");

const { startLocalSyncHttpServer } = require("../services/local-sync/http/server");
const { createRosterEndpoint } = require("../services/local-sync/http/endpoints/roster-endpoint");
const { createPreviewSummaryEndpoint } = require("../services/local-sync/http/endpoints/preview-summary-endpoint");
const { createCatalogEndpoint } = require("../services/local-sync/http/endpoints/catalog-endpoint");
const { createPreviewJobEndpoint } = require("../services/local-sync/http/endpoints/preview-job-endpoint");

/**
 * Build the `<METHOD> <pathname>` → handler map used by
 * startLocalSyncHttpServer's `apiHandlers` option. OPTIONS aliases are
 * registered alongside each verb so CORS preflight hits the same code
 * path.
 * @param {{User: object, notifyPreviewReady?: function}} deps
 * @returns {Object<string, Function>} handler map
 */
function createLocalSyncApiHandlers({
  User,
  notifyPreviewReady = null,
}) {
  const rosterHandler = createRosterEndpoint({ User });
  const previewSummaryHandler = createPreviewSummaryEndpoint({ User });
  const catalogHandler = createCatalogEndpoint();
  const previewJobHandler = createPreviewJobEndpoint({
    User,
    notifyPreviewReady,
  });

  return {
    "GET /api/local-sync/catalog": catalogHandler,
    "OPTIONS /api/local-sync/catalog": catalogHandler,
    "GET /api/me/roster": rosterHandler,
    "OPTIONS /api/me/roster": rosterHandler,
    "POST /api/local-sync/preview-summary": previewSummaryHandler,
    "OPTIONS /api/local-sync/preview-summary": previewSummaryHandler,
    "POST /api/local-sync/preview-job": previewJobHandler,
    "OPTIONS /api/local-sync/preview-job": previewJobHandler,
  };
}

/**
 * Starts the Local Reader web surface if enabled. This app-layer module owns
 * boot wiring only; the HTTP server and API handlers keep their own behavior.
 */
function startLocalSyncWebCompanion({
  rootDir,
  User,
  notifyPreviewReady = null,
  env = process.env,
  log = console,
  startHttpServer = startLocalSyncHttpServer,
} = {}) {
  if (env.LOCAL_SYNC_HTTP_DISABLED === "true") {
    log.log("[bot] LOCAL_SYNC_HTTP_DISABLED=true - skipping Local Reader HTTP server.");
    return null;
  }

  try {
    const companion = startHttpServer({
      webDir: path.join(rootDir, "web"),
      classIconsDir: path.join(rootDir, "assets", "class-icons"),
      waSqliteDir: path.join(rootDir, "node_modules", "@journeyapps", "wa-sqlite"),
      apiHandlers: createLocalSyncApiHandlers({
        User,
        notifyPreviewReady,
      }),
      log,
    });
    void companion.ready.catch((err) => {
      log.error(
        "[bot] local-sync HTTP server failed to start (continuing without Local Reader):",
        err?.message || err
      );
    });
    return companion;
  } catch (err) {
    log.error(
      "[bot] local-sync HTTP server failed to start (continuing without Local Reader):",
      err?.message || err
    );
    return null;
  }
}

module.exports = {
  createLocalSyncApiHandlers,
  startLocalSyncWebCompanion,
};
