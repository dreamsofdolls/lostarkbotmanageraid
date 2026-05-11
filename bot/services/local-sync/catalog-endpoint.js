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
