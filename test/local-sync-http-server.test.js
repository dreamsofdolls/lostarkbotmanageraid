const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { once } = require("node:events");

const { startLocalSyncHttpServer } = require("../bot/services/local-sync/http/server");

async function startTestServer({ classIconsDir = null } = {}) {
  const { server, stop } = startLocalSyncHttpServer({
    port: 0,
    webDir: path.join(__dirname, "..", "web"),
    classIconsDir,
  });
  if (!server.listening) await once(server, "listening");
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
  const { baseUrl, stop } = await startTestServer({ classIconsDir });
  try {
    const webAsset = await fetch(`${baseUrl}/sync/css/styles.css`);
    assert.equal(webAsset.status, 200);
    assert.equal(webAsset.headers.get("cache-control"), "public, max-age=300");

    const classIcon = await fetch(`${baseUrl}/sync/class-icons/bard.png`);
    assert.equal(classIcon.status, 200);
    assert.equal(classIcon.headers.get("content-type"), "image/png");
    assert.equal(classIcon.headers.get("cache-control"), "public, max-age=86400");

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
