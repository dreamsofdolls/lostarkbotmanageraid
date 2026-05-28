/**
 * services/local-sync/catalog-endpoint.js
 * GET /api/catalog handler. No auth - the catalog is public (just
 * raid/class metadata) and is shipped with a 5-min Cache-Control so
 * web companion page loads stay light.
 */

"use strict";

const { buildLocalSyncCatalog } = require("./catalog");

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
  });
  res.end(status === 204 ? "" : JSON.stringify(body));
}

/**
 * Build the GET /api/catalog handler. Factory shape kept for parity
 * with the other endpoints even though this one takes no deps.
 * @returns {Function} async (req, res) handler
 */
function createCatalogEndpoint() {
  return async function handleCatalog(req, res) {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }
    if (req.method !== "GET") {
      send(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    send(res, 200, {
      ok: true,
      catalog: buildLocalSyncCatalog(),
    });
  };
}

module.exports = { createCatalogEndpoint };
