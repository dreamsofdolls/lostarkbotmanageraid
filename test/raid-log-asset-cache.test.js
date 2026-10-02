"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { brotliDecompressSync } = require("node:zlib");
const { createAssetCache } = require("../bot/services/raid-log/asset-cache");

const URL = "https://lostark.bible/_app/immutable/chunks/fixture.js";
const CLASS_ICON_URL = "https://lostark.bible/i/classes/204.png";
function fixture({ url = URL, method = "GET", navigation = false, resourceType = "script", requestHeaders = {},
  status = 200, headers = {}, body = Buffer.from("module"), read } = {}) {
  let reads = 0;
  const request = { url: () => url, method: () => method, isNavigationRequest: () => navigation,
    resourceType: () => resourceType, headers: () => requestHeaders };
  const response = { url: () => url, request: () => request, status: () => status,
    allHeaders: async () => ({ "cache-control": "public, max-age=31536000, immutable", "content-type": "text/javascript", ...headers }),
    body: async () => { reads++; return read ? read() : body; } };
  return { request, response, body, get reads() { return reads; } };
}

test("only public immutable app assets are reused, with decoded bodies and the original MIME type", async () => {
  const cache = createAssetCache();
  const f = fixture({ headers: { "content-encoding": "gzip", "content-length": "8", vary: "Accept-Encoding" } });
  try {
    assert.equal(cache.get(f.request), undefined);
    await cache.remember(f.response);
    assert.deepEqual(cache.get(f.request), { status: 200, contentType: "text/javascript", body: f.body });
    await cache.remember(f.response);
    assert.equal(f.reads, 1, "a fulfilled asset does not copy its body back into the cache");
  } finally { cache.clear(); }
});

test("fresh numeric class PNGs are reused without Brotli recompression", async () => {
  const cache = createAssetCache();
  const body = Buffer.alloc(16 * 1024, 0x89);
  const f = fixture({ url: CLASS_ICON_URL, resourceType: "image", headers: {
    "cache-control": "max-age=14400", age: "7117", "content-type": "image/png", vary: "Accept-Encoding",
  }, body });
  try {
    await cache.remember(f.response);
    const asset = cache.get(f.request);
    assert.equal(asset.contentType, "image/png");
    assert.equal(asset.encoding, undefined);
    assert.equal(asset.body, body);
    let delivered;
    await cache.fulfill({ fulfill: async options => { delivered = options; } }, asset);
    assert.deepEqual(delivered, { status: 200, contentType: "image/png", body });
    await cache.remember(f.response);
    assert.equal(f.reads, 1);
  } finally { cache.clear(); }
});

test("class icon support does not admit arbitrary images, foreign origins or mismatched MIME types", async () => {
  const cache = createAssetCache();
  try {
    for (const options of [
      { url: "https://lostark.bible/i/classes/bard.png", resourceType: "image", headers: { "content-type": "image/png" } },
      { url: "https://lostark.bible/i/classes/204.webp", resourceType: "image", headers: { "content-type": "image/png" } },
      { url: "https://lostark.bible/i/skills/204.png", resourceType: "image", headers: { "content-type": "image/png" } },
      { url: "https://cdn.ags.lol/i/classes/204.png", resourceType: "image", headers: { "content-type": "image/png" } },
      { url: `${CLASS_ICON_URL}?character=private`, resourceType: "image", headers: { "content-type": "image/png" } },
      { url: CLASS_ICON_URL, headers: { "content-type": "image/png" } },
      { url: CLASS_ICON_URL, resourceType: "image", headers: { "content-type": "image/webp" } },
      { headers: { "content-type": "image/png" } },
    ]) {
      const f = fixture(options);
      await cache.remember(f.response);
      assert.equal(cache.get(f.request), undefined);
      assert.equal(f.reads, 0);
    }
  } finally { cache.clear(); }
});

test("class icons require fresh max-age and reject private responses before reading the body", async () => {
  const cache = createAssetCache();
  try {
    const policies = [
      { "cache-control": "public, immutable" },
      { "cache-control": "max-age=10", age: "10" },
      ...["private", "no-store", "no-cache"].map(directive => ({ "cache-control": `max-age=14400, ${directive}` })),
      { "cache-control": "max-age=14400, s-maxage=0" },
      { "cache-control": "max-age=14400", "set-cookie": "session=private" },
      { "cache-control": "max-age=14400", vary: "Cookie" },
      { "cache-control": "max-age=14400", "content-length": String(4 * 1024 * 1024 + 1) },
    ];
    for (const headers of policies) {
      const f = fixture({ url: CLASS_ICON_URL, resourceType: "image",
        headers: { "content-type": "image/png", ...headers } });
      await cache.remember(f.response);
      assert.equal(cache.get(f.request), undefined);
      assert.equal(f.reads, 0);
    }
  } finally { cache.clear(); }
});

test("authorized class icon requests neither consume nor populate the unauthenticated cache", async () => {
  const cache = createAssetCache();
  const publicIcon = fixture({ url: CLASS_ICON_URL, resourceType: "image",
    headers: { "cache-control": "max-age=14400", "content-type": "image/png" } });
  const authorized = fixture({ url: CLASS_ICON_URL, resourceType: "image",
    requestHeaders: { Authorization: "Bearer private" },
    headers: { "cache-control": "max-age=14400", "content-type": "image/png" } });
  try {
    await cache.remember(publicIcon.response);
    assert.ok(cache.get(publicIcon.request));
    assert.equal(cache.get(authorized.request), undefined);
    await cache.remember(authorized.response);
    assert.equal(authorized.reads, 0);
  } finally { cache.clear(); }
});

test("navigation, APIs, unhashed site data, foreign origins and unsuccessful responses never enter the asset cache", async () => {
  const cache = createAssetCache();
  try {
    for (const options of [{ navigation: true }, { method: "POST" }, { status: 302 }, { status: 404 },
      { url: "https://lostark.bible/logs/public-log" }, { url: "https://lostark.bible/api/logs.js" },
      { url: "https://lostark.bible/assets/character.js" }, { url: "https://cdn.ags.lol/_app/immutable/chunks/a.js" },
      { url: "https://user:secret@lostark.bible/_app/immutable/a.js" }, { url: `${URL}?character=private` }]) {
      const f = fixture(options);
      await cache.remember(f.response);
      assert.equal(cache.get(f.request), undefined);
      assert.equal(f.reads, 0);
    }
  } finally { cache.clear(); }
});

test("privacy, revalidation, cookie, Vary and MIME policies prevent caching before a body is read", async () => {
  const cache = createAssetCache();
  try {
    for (const headers of [{ "cache-control": "public, max-age=300" }, { "cache-control": "immutable" },
      ...["private", "no-store", "no-cache"].map(directive => ({ "cache-control": `public, immutable, ${directive}` })),
      { "set-cookie": "session=private" }, { vary: "Cookie" }, { vary: "*" }, { "content-type": "text/html" },
      { "content-length": String(4 * 1024 * 1024 + 1) }]) {
      const f = fixture({ headers });
      await cache.remember(f.response);
      assert.equal(cache.get(f.request), undefined);
      assert.equal(f.reads, 0);
    }
  } finally { cache.clear(); }
});

test("asset buffers stay within 4 MiB with LRU eviction and oversized decoded bodies are discarded", async () => {
  const cache = createAssetCache();
  const fixtures = Array.from({ length: 5 }, (_, index) => fixture({ url: URL.replace(".js", `${index}.js`), body: randomBytes(900 * 1024) }));
  try {
    for (const f of fixtures.slice(0, 4)) await cache.remember(f.response);
    cache.get(fixtures[0].request);
    await cache.remember(fixtures[4].response);
    assert.equal(cache.get(fixtures[1].request), undefined);
    assert.equal(cache.get(fixtures[0].request).body, fixtures[0].body);
    assert.equal(cache.get(fixtures[4].request).body, fixtures[4].body);
    const oversized = fixture({ body: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await cache.remember(oversized.response);
    assert.equal(cache.get(oversized.request), undefined);
  } finally { cache.clear(); }
});

test("large app modules are stored compressed and decode to exactly the original bytes", async () => {
  const cache = createAssetCache();
  const f = fixture({ body: Buffer.from("export const publicValue = 'module';\n".repeat(60_000)) });
  try {
    await cache.remember(f.response);
    const asset = cache.get(f.request);
    assert.ok(f.body.length > 1024 * 1024);
    assert.ok(asset.body.length < 1024 * 1024);
    assert.equal(asset.encoding, "br");
    assert.equal(asset.contentType, "text/javascript");
    assert.deepEqual(brotliDecompressSync(asset.body), f.body);
    let delivered;
    await cache.fulfill({ fulfill: async options => { delivered = options; } }, asset);
    assert.deepEqual(delivered, { status: 200, contentType: "text/javascript", body: f.body });
  } finally { cache.clear(); }
});

test("parallel imports deliver one decoded response at a time and a closed route cannot block later imports", async () => {
  const cache = createAssetCache();
  const f = fixture({ body: Buffer.from("module-content\n".repeat(1000)) });
  await cache.remember(f.response);
  const asset = cache.get(f.request);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = cache.fulfill({ fulfill: async options => {
    assert.deepEqual(options.body, f.body);
    entered();
    await new Promise(resolve => { release = resolve; });
    throw new Error("Page closed");
  } }, asset);
  const failed = assert.rejects(held, /Page closed/);
  await started;
  let delivered = false;
  const next = cache.fulfill({ fulfill: async options => { assert.deepEqual(options.body, f.body); delivered = true; } }, asset);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered, false);
  release();
  await failed;
  await next;
  assert.equal(delivered, true);
  cache.clear();
});

test("clearing the asset cache aborts queued imports before decompressing and delivering them", async () => {
  const cache = createAssetCache();
  const f = fixture({ body: Buffer.from("module-content\n".repeat(1000)) });
  await cache.remember(f.response);
  const asset = cache.get(f.request);
  let aborted = false;
  const delivered = cache.fulfill({ fulfill: async () => assert.fail("a cleared cache cannot deliver an old module"),
    abort: async () => { aborted = true; } }, asset);
  cache.clear();
  await delivered;
  assert.equal(aborted, true);
});

test("asset entry metadata is bounded as well as buffers", async () => {
  const cache = createAssetCache();
  const fixtures = Array.from({ length: 129 }, (_, index) => fixture({ url: URL.replace(".js", `${index}.js`) }));
  try {
    for (const f of fixtures) await cache.remember(f.response);
    assert.equal(cache.get(fixtures[0].request), undefined);
    assert.equal(cache.get(fixtures[128].request).body, fixtures[128].body);
  } finally { cache.clear(); }
});

test("body reads run serially and a late response cannot repopulate a cleared cache", async () => {
  const cache = createAssetCache();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = fixture({ read: () => new Promise(resolve => { release = resolve; entered(); }) });
  const next = fixture({ url: URL.replace(".js", "-next.js") });
  const first = cache.remember(held.response);
  await started;
  const second = cache.remember(next.response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(next.reads, 0);
  cache.clear();
  release(held.body);
  await Promise.all([first, second]);
  assert.equal(cache.get(held.request), undefined);
  assert.equal(cache.get(next.request), undefined);
  assert.equal(next.reads, 0);
  await cache.remember(next.response);
  assert.equal(cache.get(next.request).body, next.body);
  cache.clear();
});

test("overlapping responses for one immutable URL read and compress its body once", async () => {
  const cache = createAssetCache();
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const body = Buffer.from("module-content\n".repeat(1000));
  const first = fixture({ read: () => { enter(); return new Promise(resolve => { release = resolve; }); } });
  const duplicates = Array.from({ length: 12 }, () => fixture({ body }));
  const remembered = cache.remember(first.response);
  await entered;
  const pending = duplicates.map(f => cache.remember(f.response));
  release(body);
  try {
    await Promise.all([remembered, ...pending]);
    assert.equal(first.reads + duplicates.reduce((sum, f) => sum + f.reads, 0), 1);
    assert.deepEqual(brotliDecompressSync(cache.get(first.request).body), body);
  } finally { cache.clear(); }
});

test("the immutable asset backlog is bounded while a body read is held", async () => {
  const cache = createAssetCache();
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = fixture({ read: () => { enter(); return new Promise(resolve => { release = resolve; }); } });
  const first = cache.remember(held.response);
  await entered;
  const queued = Array.from({ length: 100 }, (_, index) => fixture({ url: URL.replace(".js", `-queued-${index}.js`) }));
  const pending = queued.map(f => cache.remember(f.response));
  release(held.body);
  try {
    await Promise.all([first, ...pending]);
    assert.equal(held.reads + queued.reduce((sum, f) => sum + f.reads, 0), 64);
    await cache.remember(queued.at(-1).response);
    assert.equal(queued.at(-1).reads, 1, "a response skipped under pressure can be cached on a later navigation");
  } finally { cache.clear(); }
});

test("a discarded response body leaves the network fallback available for the next request", async () => {
  const cache = createAssetCache();
  const failed = fixture({ read: async () => { throw new Error("Browser closed"); } });
  try {
    await cache.remember(failed.response);
    assert.equal(cache.get(failed.request), undefined);
    const healthy = fixture();
    await cache.remember(healthy.response);
    assert.equal(cache.get(healthy.request).body, healthy.body);
  } finally { cache.clear(); }
});

test("static assets expire while idle without waiting for another log capture", async t => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cache = createAssetCache();
  const f = fixture();
  await cache.remember(f.response);
  now = 5 * 60_000;
  t.mock.timers.tick(now);
  now = 0;
  assert.equal(cache.get(f.request), undefined);
  cache.clear();
});

test("server freshness including Age caps the cache lifetime instead of being extended to five minutes", async t => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cache = createAssetCache();
  const f = fixture({ headers: { "cache-control": "public, immutable, max-age=10", age: "9" } });
  await cache.remember(f.response);
  now = 999;
  assert.ok(cache.get(f.request));
  now = 1000;
  t.mock.timers.tick(1000);
  now = 0;
  assert.equal(cache.get(f.request), undefined);
  for (const headers of [{ "cache-control": "public, immutable, max-age=0" },
    { "cache-control": "public, immutable" }, { age: "31536001" }]) {
    const stale = fixture({ headers });
    await cache.remember(stale.response);
    assert.equal(stale.reads, 0);
    assert.equal(cache.get(stale.request), undefined);
  }
  cache.clear();
});
