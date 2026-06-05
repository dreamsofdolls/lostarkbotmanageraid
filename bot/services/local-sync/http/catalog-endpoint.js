/**
 * services/local-sync/http/catalog-endpoint.js
 * GET /api/catalog handler. No auth - the catalog is public (just
 * raid/class metadata) and is shipped with a 5-min Cache-Control so
 * web companion page loads stay light.
 */

"use strict";

const { buildLocalSyncCatalog } = require("../core/catalog");
const { createJsonSender } = require("./json");
const { guardHttpMethod } = require("./request-gates");

const send = createJsonSender({
  methods: "GET, OPTIONS",
  allowHeaders: "Content-Type",
  extraHeaders: (status) => ({
    "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
  }),
});

/**
 * Build the GET /api/catalog handler. Factory shape kept for parity
 * with the other endpoints even though this one takes no deps.
 * @returns {Function} async (req, res) handler
 */
function createCatalogEndpoint() {
  return async function handleCatalog(req, res) {
    if (!guardHttpMethod({ req, res, send, method: "GET" })) return;
    send(res, 200, {
      ok: true,
      catalog: buildLocalSyncCatalog(),
    });
  };
}

module.exports = { createCatalogEndpoint };
