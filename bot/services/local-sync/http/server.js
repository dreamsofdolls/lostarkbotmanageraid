/**
 * services/local-sync/http/server.js
 * Node-builtin HTTP server hosting the local-sync web companion +
 * JSON API. Stays Express-free (under 200 LOC) by exposing
 * `apiHandlers` as a `<METHOD> <pathname>` lookup so callers can wire
 * additional endpoints without a router. Sandboxed to `webDir` (path
 * traversal rejected before disk read) and bound to 0.0.0.0 so the
 * Railway load balancer can reach it.
 */

"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { SECURITY_HEADERS } = require("./security-headers");

const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Minimal HTTP server for the local-sync web companion. Built on Node's
 * built-in http module to avoid an Express dependency. It serves the
 * companion assets and dispatches exact method/path API handlers supplied
 * by the composition root.
 *
 * Listens on `process.env.PORT || 3000` (Railway provides PORT in prod).
 * Bound to 0.0.0.0 so Railway's load balancer can reach it; do not bind
 * to 127.0.0.1 or the deploy will appear "unhealthy" because no public
 * traffic can land.
 *
 * Sandboxed to the `webDir` argument - any path traversal attempt
 * (`../../etc/passwd`) is rejected before disk access by resolving the path
 * and verifying that it remains within webDir.
 */

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
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

function sendStaticFileResponse(res, result, cacheControl) {
  if (result.error === "forbidden") {
    res.writeHead(403, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  if (result.error === "not_found") {
    res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  if (result.error) {
    res.writeHead(500, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    res.end("server error");
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": result.mime,
    "Cache-Control": cacheControl,
  });
  res.end(result.data);
}

function getEnvPort(fallback = 3000) {
  const raw = Number(process.env.PORT);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return fallback;
}

/**
 * Start the HTTP server. Returns `{ server, stop }` so the bot entry
 * point can graceful-shutdown alongside the Discord client. `apiHandlers`
 * is a map keyed by exact `<METHOD> <pathname>` strings.
 */
function startLocalSyncHttpServer({
  port = getEnvPort(),
  webDir,
  classIconsDir = null,
  waSqliteDir = null,
  apiHandlers = {},
  log = console,
  shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
} = {}) {
  if (!webDir) {
    throw new Error("[local-sync/http-server] webDir is required");
  }
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      // Health probe - Railway pings this to detect "service ready".
      // Returns an empty 200 response to minimize probe overhead.
      if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }
      // API handlers use exact `<METHOD> <pathname>` lookup; keep this
      // deliberately small and router-free.
      const apiKey = `${req.method} ${pathname}`;
      if (typeof apiHandlers[apiKey] === "function") {
        await apiHandlers[apiKey](req, res);
        return;
      }
      // Static class icons used by the web preview. Kept outside webDir so
      // Discord emoji bootstrap and web companion share one asset source.
      if (req.method === "GET" && classIconsDir && pathname.startsWith("/sync/class-icons/")) {
        const rel = pathname.replace(/^\/sync\/class-icons\/?/, "");
        const result = await tryReadFileFromRoot(classIconsDir, rel);
        sendStaticFileResponse(res, result, "public, max-age=86400");
        return;
      }
      // Self-host the pinned wa-sqlite package. The Local Reader handles a
      // user-selected encounters.db file, so executable CDN code must not
      // share its page context or gain access to the file/token.
      if (req.method === "GET" && waSqliteDir && pathname.startsWith("/sync/vendor/wa-sqlite/")) {
        const rel = pathname.replace(/^\/sync\/vendor\/wa-sqlite\/?/, "");
        const result = await tryReadFileFromRoot(waSqliteDir, rel);
        sendStaticFileResponse(res, result, "public, max-age=31536000, immutable");
        return;
      }
      // Static path: only serve under /sync/*. Anything else falls through to 404.
      if (req.method === "GET" && pathname.startsWith("/sync")) {
        const result = await tryReadStaticFile(webDir, pathname);
        sendStaticFileResponse(res, result, "public, max-age=300");
        return;
      }
      res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      console.error("[local-sync/http-server] request handler threw:", err?.message || err);
      try {
        res.writeHead(500, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        res.end("server error");
      } catch {
        // Headers already sent or socket closed - nothing to do.
      }
    }
  });
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  server.on("error", (err) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(err);
      return;
    }
    log.error("[local-sync/http-server] runtime server error:", err?.message || err);
  });
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    readySettled = true;
    log.log(`[local-sync/http-server] listening on 0.0.0.0:${actualPort} (webDir=${webDir})`);
    resolveReady({ port: actualPort });
  });
  let stopPromise = null;
  return {
    server,
    ready,
    stop() {
      if (stopPromise) return stopPromise;
      if (!server.listening) return Promise.resolve();

      const graceMs = Number.isFinite(shutdownGraceMs) && shutdownGraceMs >= 0
        ? shutdownGraceMs
        : DEFAULT_SHUTDOWN_GRACE_MS;
      stopPromise = new Promise((resolve, reject) => {
        let forceTimer = null;
        const finish = (err) => {
          if (forceTimer) clearTimeout(forceTimer);
          if (err) reject(err);
          else resolve();
        };

        try {
          server.close(finish);
          // Idle keep-alive sockets do not need the full grace window.
          server.closeIdleConnections?.();
          forceTimer = setTimeout(() => {
            server.closeAllConnections?.();
          }, graceMs);
          forceTimer.unref?.();
        } catch (err) {
          finish(err);
        }
      });
      return stopPromise;
    },
  };
}

module.exports = {
  startLocalSyncHttpServer,
};
