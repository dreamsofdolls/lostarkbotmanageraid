"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { createBibleClient } = require("../bot/services/auto-manage/bible/client");
const { BibleRequestLimiter } = require("../bot/services/auto-manage/bible/rate-limit");

function streamedClient(chunks) {
  const state = { reads: 0, bytes: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks[state.reads++];
      if (!chunk) return controller.close();
      state.bytes += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  const client = createBibleClient({ bibleLimiter: { run: fn => fn() },
    fetchImpl: async () => new Response(body) });
  return { client, state };
}

test("profile stops after its complete header without downloading unrelated roster data", async () => {
  const prefix = Buffer.from('<title>Sáturn (NA) | lostark.bible</title><script>data:{header:{id:123,sn:"serial",rid:456,class:"blade"},redirectedFrom:null},roster:[');
  const splitName = prefix.indexOf(Buffer.from("á")) + 1;
  const splitRid = prefix.indexOf(Buffer.from("rid:456")) + "rid:45".length;
  const { client, state } = streamedClient([
    prefix.subarray(0, splitName), prefix.subarray(splitName, splitRid), prefix.subarray(splitRid),
    Buffer.from('{name:"Other",class:"bard",payload:"' + "x".repeat(4 * 1024 * 1024) + '"}]}</script>'),
  ]);
  assert.deepEqual(await client.fetchBibleCharacterProfileWithLimiter("Sáturn"),
    { cid: 123, sn: "serial", rid: 456, name: "Sáturn", className: "Deathblade" });
  assert.equal(state.bytes, prefix.length);
  assert.equal(state.cancelled, true);
});

test("metadata waits for the complete rid then cancels the roster stream", async () => {
  const chunks = [Buffer.from('<script>data:{header:{id:123,sn:"serial",rid:45'), Buffer.from('6,class:"blade"},'),
    Buffer.from('roster:["' + "x".repeat(4 * 1024 * 1024) + '"]}</script>')];
  const { client, state } = streamedClient(chunks);
  assert.deepEqual(await client.fetchBibleCharacterMetaWithLimiter("Saturn"), { cid: 123, sn: "serial", rid: 456 });
  assert.equal(state.bytes, chunks[0].length + chunks[1].length);
  assert.equal(state.cancelled, true);
});

test("title and bootstrap markers can be split across one-byte chunks", async () => {
  const prefix = Buffer.from('<title>Sáturn (NA) | lostark.bible</title><script>data:{header:{id:123,sn:"serial",rid:456,class:"blade"},redirectedFrom:null},');
  const { client, state } = streamedClient([...prefix].map(byte => Uint8Array.of(byte)));
  assert.deepEqual(await client.fetchBibleCharacterProfileWithLimiter("Sáturn"),
    { cid: 123, sn: "serial", rid: 456, name: "Sáturn", className: "Deathblade" });
  assert.ok(state.bytes < prefix.length);
  assert.equal(state.cancelled, true);
});

test("a profile without its requested header class does not take another roster member's class", async () => {
  const prefix = Buffer.from('<title>Saturn (NA) | lostark.bible</title><script>data:{header:{id:123,sn:"serial",rid:456},redirectedFrom:null},');
  const { client, state } = streamedClient([prefix, Buffer.from('roster:[{class:"bard"}]}</script>')]);
  await assert.rejects(client.fetchBibleCharacterProfileWithLimiter("Saturn"), /Could not parse bible profile/);
  assert.equal(state.bytes, prefix.length);
  assert.equal(state.cancelled, true);
});

test("an unreadable roster stream stops at the byte budget and releases the body", async () => {
  const chunks = Array.from({ length: 16 }, () => Buffer.alloc(1024 * 1024, "x"));
  const { client, state } = streamedClient(chunks);
  await assert.rejects(client.fetchBibleCharacterProfileWithLimiter("Saturn"), /roster page exceeded/);
  assert.ok(state.bytes <= 9 * 1024 * 1024);
  assert.equal(state.cancelled, true);
});

test("changed header shapes do not rescan the whole accumulated page per chunk", async () => {
  const chunks = [Buffer.from("<title>Maintenance</title>header:{id:123,changedShape:"),
    ...Array.from({ length: 4096 }, () => Buffer.from("</title>" + "x".repeat(4088)))];
  const { client, state } = streamedClient(chunks);
  const originalTest = RegExp.prototype.test;
  let longestIdentityScan = 0;
  RegExp.prototype.test = function (value) {
    if (this.source.startsWith("header:") || this.source.startsWith("<title>")) {
      longestIdentityScan = Math.max(longestIdentityScan, value.length);
    }
    return originalTest.call(this, value);
  };
  try {
    await assert.rejects(client.fetchBibleCharacterProfileWithLimiter("Saturn"), /roster page exceeded/);
    assert.ok(longestIdentityScan <= 64 * 1024);
    assert.ok(state.bytes <= 8 * 1024 * 1024 + 4096);
    assert.equal(state.cancelled, true);
  } finally { RegExp.prototype.test = originalTest; }
});

test("a late title and unusually long valid serial still parse through the complete-page fallback", async () => {
  const serial = "s".repeat(70 * 1024);
  const chunks = [Buffer.alloc(70 * 1024, "x"), Buffer.from('<title>Saturn (NA) | lostark.bible</title><script>header:{id:123,sn:"'),
    Buffer.from(serial), Buffer.from('",rid:456,class:"blade"},redirectedFrom:null}</script>')];
  const { client } = streamedClient(chunks);
  assert.deepEqual(await client.fetchBibleCharacterProfileWithLimiter("Saturn"),
    { cid: 123, sn: serial, rid: 456, name: "Saturn", className: "Deathblade" });
});

test("abort during a native HTTP body read releases the Bible limiter", async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.write('<title>Saturn (NA) | lostark.bible</title><script>header:{id:123,sn:"serial",rid:45');
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let receivedHeaders;
  const ready = new Promise(resolve => { receivedHeaders = resolve; });
  const limiter = new BibleRequestLimiter(1);
  const client = createBibleClient({ bibleLimiter: limiter, fetchImpl: async (_, options) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, options);
    receivedHeaders();
    return response;
  } });
  const controller = new AbortController();
  const reading = client.fetchBibleCharacterProfileWithLimiter("Saturn", { signal: controller.signal });
  const rejected = assert.rejects(reading, { name: "AbortError" });
  await ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(limiter.active, 1);
  controller.abort();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(limiter.active, 0);
});
