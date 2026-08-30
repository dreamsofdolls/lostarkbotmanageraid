const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { startLocalSyncHttpServer } = require("../bot/services/local-sync/http/server");
const { startLocalSyncWebCompanion } = require("../bot/app/local-sync-web");

async function startTestServer({ classIconsDir = null, waSqliteDir = null } = {}) {
  const { server, ready, stop } = startLocalSyncHttpServer({
    port: 0,
    webDir: path.join(__dirname, "..", "web"),
    classIconsDir,
    waSqliteDir,
  });
  await ready;
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop,
  };
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
