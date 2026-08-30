const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const { startLocalSyncHttpServer } = require("../bot/services/local-sync/http/server");
const { startLocalSyncWebCompanion } = require("../bot/app/local-sync-web");
const { createJsonSender, readJsonBody } = require("../bot/services/local-sync/http/json");

async function startTestServer({
  apiHandlers = {},
  classIconsDir = null,
  shutdownGraceMs,
  waSqliteDir = null,
} = {}) {
  const { server, ready, stop } = startLocalSyncHttpServer({
    port: 0,
    webDir: path.join(__dirname, "..", "web"),
    classIconsDir,
    apiHandlers,
    shutdownGraceMs,
    waSqliteDir,
  });
  await ready;
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    stop,
  };
}

function postChunkedJson(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        status: res.statusCode,
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("local-sync web server serves browser helper modules", async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    for (const [route, expectedContentType] of [
      ["/sync", /text\/html/],
      ["/sync/css/styles.css", /text\/css/],
      ["/sync/js/app.js", /application\/javascript/],
    ]) {
      const resp = await fetch(`${baseUrl}${route}`);
      assert.equal(resp.status, 200, `${route} should be served`);
      assert.match(resp.headers.get("content-type") || "", expectedContentType);
      assert.equal(resp.headers.get("referrer-policy"), "no-referrer");
      assert.match(resp.headers.get("content-security-policy") || "", /script-src 'self'/);
    }

    for (const [route, expectedExport] of [
      ["/sync/js/core/auth.js", "bootstrapAuthSession"],
      ["/sync/js/core/html.js", "escapeHtml"],
      ["/sync/js/core/format.js", "formatBytes"],
      ["/sync/js/sync/file/file-change-monitor.js", "readFileRevision"],
      ["/sync/js/sync/render/preview-renderer.js", "renderDiffPage"],
      ["/sync/js/sync/sqlite-schema.js", "resolveEncounterSource"],
    ]) {
      const resp = await fetch(`${baseUrl}${route}`);
      assert.equal(resp.status, 200, `${route} should be served`);
      assert.match(resp.headers.get("content-type") || "", /application\/javascript/);
      const body = await resp.text();
      assert.match(body, new RegExp(`export (?:async )?function ${expectedExport}`));
    }
  } finally {
    await stop();
  }
});

test("local-sync preview escapes SQLite schema metadata before innerHTML", async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    const resp = await fetch(`${baseUrl}/sync/js/sync/render/preview-renderer.js`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(
      body,
      /escapeHtml\(t\("preview\.schemaDebug", meta\.schemaDebug\)\)/
    );
  } finally {
    await stop();
  }
});

test("local-sync static roots share response handling while keeping separate cache TTLs", async () => {
  const classIconsDir = path.join(__dirname, "..", "assets", "class-icons");
  const waSqliteDir = path.join(__dirname, "..", "node_modules", "@journeyapps", "wa-sqlite");
  const { baseUrl, stop } = await startTestServer({ classIconsDir, waSqliteDir });
  try {
    const webAsset = await fetch(`${baseUrl}/sync/css/styles.css`);
    assert.equal(webAsset.status, 200);
    assert.equal(webAsset.headers.get("cache-control"), "public, max-age=300");

    const classIcon = await fetch(`${baseUrl}/sync/class-icons/bard.png`);
    assert.equal(classIcon.status, 200);
    assert.equal(classIcon.headers.get("content-type"), "image/png");
    assert.equal(classIcon.headers.get("cache-control"), "public, max-age=86400");

    const waSqliteModule = await fetch(
      `${baseUrl}/sync/vendor/wa-sqlite/dist/wa-sqlite-async.mjs`
    );
    assert.equal(waSqliteModule.status, 200);
    assert.match(waSqliteModule.headers.get("content-type") || "", /application\/javascript/);
    assert.equal(
      waSqliteModule.headers.get("cache-control"),
      "public, max-age=31536000, immutable"
    );

    for (const route of [
      "/sync/missing-static-file.js",
      "/sync/class-icons/missing-class.png",
    ]) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 404);
      assert.equal(await response.text(), "not found");
    }
  } finally {
    await stop();
  }
});

test("local-sync HTTP bind failures reject ready without an uncaught server error", async () => {
  const first = startLocalSyncHttpServer({
    port: 0,
    webDir: path.join(__dirname, "..", "web"),
  });
  await first.ready;
  const port = first.server.address().port;
  const second = startLocalSyncHttpServer({
    port,
    webDir: path.join(__dirname, "..", "web"),
  });

  try {
    await assert.rejects(second.ready, (error) => error?.code === "EADDRINUSE");
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("local-sync JSON API returns 413 for a chunked oversized body without resetting the socket", async () => {
  const send = createJsonSender({ methods: "POST" });
  const { baseUrl, stop } = await startTestServer({
    apiHandlers: {
      "POST /limited-json": async (req, res) => {
        try {
          const body = await readJsonBody(req, 64);
          send(res, 200, { ok: true, body });
        } catch (err) {
          send(res, err.status || 500, { ok: false, error: err.message });
        }
      },
    },
  });

  try {
    const response = await postChunkedJson(
      `${baseUrl}/limited-json`,
      JSON.stringify({ payload: "x".repeat(256) })
    );
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: "body too large" });
  } finally {
    await stop();
  }
});

test("local-sync HTTP shutdown force-closes an active request after its grace window", async () => {
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const { baseUrl, stop } = await startTestServer({
    shutdownGraceMs: 20,
    apiHandlers: {
      "POST /hang": async () => {
        markEntered();
        await new Promise(() => {});
      },
    },
  });

  const req = http.request(`${baseUrl}/hang`, { method: "POST" });
  req.on("error", () => {});
  req.flushHeaders();
  await entered;

  let timeout;
  try {
    await Promise.race([
      stop(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("HTTP shutdown remained stuck")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    req.destroy();
  }
});

test("Local Reader startup failure is logged and degraded instead of rejecting globally", async () => {
  const errors = [];
  const companion = startLocalSyncWebCompanion({
    rootDir: path.join(__dirname, ".."),
    User: {},
    log: {
      log() {},
      error(...args) {
        errors.push(args);
      },
    },
    startHttpServer() {
      return {
        ready: Promise.reject(Object.assign(new Error("port busy"), { code: "EADDRINUSE" })),
        async stop() {},
      };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(companion);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /continuing without Local Reader/);
  assert.equal(errors[0][1], "port busy");
});
