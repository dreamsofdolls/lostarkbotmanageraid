"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const UserBackground = require("../bot/models/userBackground");
const bgLoader = require("../bot/services/raid-card/bg-loader");

function mockBackgroundReads(t, createImage) {
  const reads = [];
  t.mock.method(UserBackground, "findOne", ({ discordId }) => ({
    select: (fields) => ({ lean: async () => {
      reads.push({ discordId, fields });
      return fields === "updatedAt"
        ? { updatedAt: 1 }
        : { updatedAt: 1, imageData: createImage(discordId) };
    } }),
  }));
  bgLoader.clearBackgroundCache();
  t.after(() => bgLoader.clearBackgroundCache());
  return reads;
}

test("background cache bounds retained bytes independently of its image count", async (t) => {
  mockBackgroundReads(t, () => Buffer.alloc(2 * 1024 * 1024));
  for (let index = 0; index < 40; index++) {
    await bgLoader.loadBackgroundBuffer(`budget-owner-${index}`);
  }
  let retainedBytes = 0;
  for (let index = 0; index < 40; index++) {
    retainedBytes += bgLoader._cache.get(`budget-owner-${index}:`)?.buffer.length || 0;
  }
  assert.equal(retainedBytes, 16 * 1024 * 1024);
});

test("background byte eviction keeps the recently read image", async (t) => {
  mockBackgroundReads(t, () => Buffer.alloc(2 * 1024 * 1024));
  for (let index = 0; index < 8; index++) await bgLoader.loadBackgroundBuffer(`lru-owner-${index}`);
  const recentlyRead = await bgLoader.loadBackgroundBuffer("lru-owner-0");
  await bgLoader.loadBackgroundBuffer("lru-owner-8");
  assert.equal(bgLoader._cache.get("lru-owner-0:").buffer, recentlyRead);
  assert.equal(bgLoader._cache.get("lru-owner-1:"), undefined);
});

test("replacing an image at capacity preserves unrelated cached images", async (t) => {
  mockBackgroundReads(t, () => Buffer.from("original"));
  for (let index = 0; index < 40; index++) await bgLoader.loadBackgroundBuffer(`replace-owner-${index}`);
  const replacement = Buffer.from("replacement");
  t.mock.method(UserBackground, "findOne", () => ({ select: (fields) => ({ lean: async () => (
    fields === "updatedAt" ? { updatedAt: 2 } : { updatedAt: 2, imageData: replacement }
  ) }) }));
  assert.equal(await bgLoader.loadBackgroundBuffer("replace-owner-39"), replacement);
  assert.ok(bgLoader._cache.get("replace-owner-0:"));
});

test("background cache retains the count limit for small images", async (t) => {
  mockBackgroundReads(t, () => Buffer.from("small-image"));
  for (let index = 0; index < 41; index++) await bgLoader.loadBackgroundBuffer(`small-owner-${index}`);
  assert.equal(bgLoader._cache.get("small-owner-0:"), undefined);
  assert.ok(bgLoader._cache.get("small-owner-40:"));
});

test("background expiry releases unread images and makes the next read cold", async (t) => {
  const reads = mockBackgroundReads(t, () => Buffer.from("expiry-image"));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const modulePath = require.resolve("../bot/services/raid-card/bg-loader");
  delete require.cache[modulePath];
  const expiringLoader = require(modulePath);
  t.after(() => expiringLoader.clearBackgroundCache());
  await expiringLoader.loadBackgroundBuffer("expiry-owner");
  const deletedKeys = [];
  const deleteEntry = Map.prototype.delete;
  t.mock.method(Map.prototype, "delete", function (key) {
    if (key === "expiry-owner:") deletedKeys.push(key);
    return deleteEntry.call(this, key);
  });
  t.mock.timers.tick(10 * 60 * 1000);
  assert.deepEqual(deletedKeys, ["expiry-owner:"], "expiry must release bytes without a cache read");
  assert.equal((await expiringLoader.loadBackgroundBuffer("expiry-owner")).toString(), "expiry-image");
  assert.equal(reads.length, 2);
  assert.ok(reads.every(({ fields }) => fields.includes("imageData")));
});
