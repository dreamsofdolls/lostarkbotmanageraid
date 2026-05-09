"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const url = require("node:url");

/**
 * Tiny HTTP server for the local-sync web companion. Built on Node's
 * built-in http module so we avoid pulling in Express - the only routes
 * we need are static file serving (Phase 3) and the eventual POST
 * /api/raid-sync endpoint (Phase 4). Anything more elaborate would be a
 * cue to add Express, but this stays under 200 LOC for now.
 *
 * Listens on `process.env.PORT || 3000` (Railway provides PORT in prod).
 * Bound to 0.0.0.0 so Railway's load balancer can reach it; do not bind
 * to 127.0.0.1 or the deploy will appear "unhealthy" because no public
 * traffic can land.
 *
 * Sandboxed to the `webDir` argument - any path traversal attempt
 * (`../../etc/passwd`) is rejected before the disk read because we
 * resolve + verify the resolved path stays within webDir.
 */

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

function pickMime(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function tryReadFileFromRoot(rootDir, relPath) {
  if (!relPath) return { error: "not_found" };
  const root = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, relPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { error: "forbidden" };
  }
  try {
    const data = await fs.readFile(resolved);
    return { data, mime: pickMime(resolved) };
  } catch (err) {
    if (err.code === "ENOENT") return { error: "not_found" };
    return { error: "read_failed", detail: err.message };
  }
}

async function tryReadStaticFile(webDir, requestPath) {
  // Strip the /sync prefix and normalize. Empty / "/" / "/index" all map
  // to index.html so the user can land on bare /sync without a 404.
  let rel = requestPath.replace(/^\/sync\/?/, "");
  if (rel === "" || rel === "index") rel = "index.html";
  // Reject decoded traversal attempts up front. resolve() collapses
  // ../ but a request for `/sync/..%2F..%2Fbot.js` still tries to
  // escape webDir; the join + startsWith check below catches that.
  return tryReadFileFromRoot(webDir, rel);
}

function getEnvPort(fallback = 3000) {
  const raw = Number(process.env.PORT);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return fallback;
}

/**
 * Start the HTTP server. Returns `{ server, stop }` so the bot entry
 * point can graceful-shutdown alongside the Discord client. `apiHandlers`
 * is a map keyed by HTTP method + path prefix that Phase 4 plugs into;
 * Phase 3 leaves it empty.
 */
function startLocalSyncHttpServer({ port = getEnvPort(), webDir, classIconsDir = null, apiHandlers = {} } = {}) {
  if (!webDir) {
    throw new Error("[local-sync/http-server] webDir is required");
  }
  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      // Health probe - Railway pings this to detect "service ready".
      // Returns plain 200 with no body so the probe is cheap.
      if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }
      // API handlers (Phase 4 plugs in /api/raid-sync). Lookup by
      // `<METHOD> <pathname>` exact match - keep simple, no router.
      const apiKey = `${req.method} ${pathname}`;
      if (typeof apiHandlers[apiKey] === "function") {
        await apiHandlers[apiKey](req, res, parsed);
        return;
      }
      // Static class icons used by the web preview. Kept outside webDir so
      // Discord emoji bootstrap and web companion share one asset source.
      if (req.method === "GET" && classIconsDir && pathname.startsWith("/sync/class-icons/")) {
        const rel = pathname.replace(/^\/sync\/class-icons\/?/, "");
        const result = await tryReadFileFromRoot(classIconsDir, rel);
        if (result.error === "forbidden") {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("forbidden");
          return;
        }
        if (result.error === "not_found") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        if (result.error) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("server error");
          return;
        }
        res.writeHead(200, {
          "Content-Type": result.mime,
          "Cache-Control": "public, max-age=86400",
        });
        res.end(result.data);
        return;
      }
      // Static path: only serve under /sync/*. Anything else falls through to 404.
      if (req.method === "GET" && pathname.startsWith("/sync")) {
        const result = await tryReadStaticFile(webDir, pathname);
        if (result.error === "forbidden") {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("forbidden");
          return;
        }
        if (result.error === "not_found") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        if (result.error) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("server error");
          return;
        }
        res.writeHead(200, {
          "Content-Type": result.mime,
          "Cache-Control": "public, max-age=300",
        });
        res.end(result.data);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      console.error("[local-sync/http-server] request handler threw:", err?.message || err);
      try {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("server error");
      } catch {
        // Headers already sent or socket closed - nothing to do.
      }
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[local-sync/http-server] listening on 0.0.0.0:${port} (webDir=${webDir})`);
  });
  return {
    server,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = {
  startLocalSyncHttpServer,
};
