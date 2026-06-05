const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { once } = require("node:events");

const { startLocalSyncHttpServer } = require("../bot/services/local-sync/http-server");

async function startTestServer() {
  const { server, stop } = startLocalSyncHttpServer({
    port: 0,
    webDir: path.join(__dirname, "..", "web"),
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop,
  };
}

test("local-sync web server serves raid-profile browser helper modules", async () => {
  const { baseUrl, stop } = await startTestServer();
  try {
    for (const [route, expectedExport] of [
      ["/sync/profile-role.js", "classifyProfileLogRole"],
      ["/sync/profile-metrics.js", "computeProfileConsistency"],
    ]) {
      const resp = await fetch(`${baseUrl}${route}`);
      assert.equal(resp.status, 200, `${route} should be served`);
      assert.match(resp.headers.get("content-type") || "", /application\/javascript/);
      const body = await resp.text();
      assert.match(body, new RegExp(`export function ${expectedExport}`));
    }
  } finally {
    await stop();
  }
});
