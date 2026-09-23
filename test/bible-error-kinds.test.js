"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBibleClient } = require("../bot/services/auto-manage/bible/client");
const {
  BibleRequestLimiter,
  createBibleHttpError,
} = require("../bot/services/auto-manage/bible/rate-limit");
const {
  BIBLE_ERROR_KIND,
  classifyBibleError,
  isPublicLogDisabledError,
} = require("../bot/services/auto-manage/bible/error-kinds");

// Trimmed from the live lostark.bible pages: an unknown name gets HTTP 200
// and a "Character Not Found" page whose SSR data sets `header:void 0`.
const FOUND_PAGE = '<script>kit.start(app, element, { data: [{type:"data",data:{header:{id:90755,sn:"200000072887895",rid:221554,ilvl:1662.5}}}] });</script>';
const NOT_FOUND_PAGE = [
  '<h1 class="mt-2 text-center text-3xl font-bold max-xl:text-2xl">Character Not Found</h1>',
  '<script>kit.start(app, element, { node_ids: [0, 2, 20], data: [{type:"data",data:{userData:void 0},uses:{}},{type:"data",data:{header:void 0,redirectedFrom:null,suggestions:[]},uses:{params:["region","name"]}},{type:"data",data:{roster:[]},uses:{parent:1}}], form: null, error: null });</script>',
].join("\n");

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function clientAnswering(status, body) {
  return createBibleClient({
    bibleLimiter: { run: (fn) => fn() },
    fetchImpl: async () => fakeResponse(status, body),
  });
}

function captureRejection(promise) {
  return promise.then(
    () => assert.fail("expected the Bible request to fail"),
    (error) => error
  );
}

// Reports keep only the message (gather.js), so each kind must survive that.
function assertKind(error, kind) {
  assert.equal(classifyBibleError(error), kind);
  assert.equal(classifyBibleError(error.message), kind);
}

const LOGS_ARGS = { serial: "200000072887895", cid: 90755, rid: 221554, className: "Paladin", weekResetStart: 0 };

test("a name lostark.bible does not know is notFound, a found page still gives its ids", async () => {
  const meta = await clientAnswering(200, FOUND_PAGE).fetchBibleCharacterMetaWithLimiter("Stylonius");
  assert.deepEqual(meta, { cid: 90755, sn: "200000072887895", rid: 221554 });

  const error = await captureRejection(
    clientAnswering(200, NOT_FOUND_PAGE).fetchBibleCharacterMetaWithLimiter("Qzxvwkjhgfdq")
  );
  assertKind(error, BIBLE_ERROR_KIND.notFound);
  assert.match(error.message, /Qzxvwkjhgfdq/);
});

test("a not-found name that reads like a rate limit stays notFound", async () => {
  const error = await captureRejection(
    clientAnswering(200, NOT_FOUND_PAGE).fetchBibleCharacterMetaWithLimiter("Ratelimit")
  );
  assertKind(error, BIBLE_ERROR_KIND.notFound);
});

test("a Bible 429 and the limiter's backoff are rateLimit", async () => {
  const limiter = new BibleRequestLimiter(1, { nowMs: () => 0, log: { warn: () => {} } });
  const first = await captureRejection(limiter.run(async () => {
    throw createBibleHttpError('Bible roster page returned HTTP 429 for "Kanna"', { status: 429 });
  }));
  const backoff = await captureRejection(limiter.run(async () => {}));

  assert.equal(backoff.isBibleBackoff, true);
  assertKind(first, BIBLE_ERROR_KIND.rateLimit);
  assertKind(backoff, BIBLE_ERROR_KIND.rateLimit);
});

test("a private character's 403 is publicLogOff, any other 403 is blocked", async () => {
  const privateLogs = await captureRejection(
    clientAnswering(403, '{"error":"Logs not enabled"}').fetchBibleLogsSinceWeekReset(LOGS_ARGS)
  );
  assertKind(privateLogs, BIBLE_ERROR_KIND.publicLogOff);
  assert.equal(isPublicLogDisabledError(privateLogs), true);
  assert.equal(isPublicLogDisabledError(null), false);

  const challengedLogs = await captureRejection(
    clientAnswering(403, "<!DOCTYPE html><title>Just a moment...</title>").fetchBibleLogsSinceWeekReset(LOGS_ARGS)
  );
  assertKind(challengedLogs, BIBLE_ERROR_KIND.blocked);
  assert.equal(isPublicLogDisabledError(challengedLogs), false);

  const blockedPage = await captureRejection(
    clientAnswering(403, "").fetchBibleCharacterMetaWithLimiter("Kanna")
  );
  assertKind(blockedPage, BIBLE_ERROR_KIND.blocked);
  assertKind(createBibleHttpError("LostArk Bible HTTP 403", { status: 403 }), BIBLE_ERROR_KIND.blocked);
});

test("an unreadable page, a 503 and a network failure stay other", async () => {
  const unreadable = await captureRejection(
    clientAnswering(200, "<html><body>maintenance</body></html>").fetchBibleCharacterMetaWithLimiter("Kanna")
  );
  assert.match(unreadable.message, /Could not parse bible metadata/);
  assertKind(unreadable, BIBLE_ERROR_KIND.other);

  const unavailable = await captureRejection(
    clientAnswering(503, "").fetchBibleCharacterMetaWithLimiter("Kanna")
  );
  assertKind(unavailable, BIBLE_ERROR_KIND.other);
  assertKind(new TypeError("fetch failed"), BIBLE_ERROR_KIND.other);
});
