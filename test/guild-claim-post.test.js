"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sendClaimedPost } = require("../bot/services/raid/schedulers/guild-state-claim");

// A claim on `lastKey` whose rollback records its filter and update.
function makeClaim() {
  const rollbacks = [];
  const claim = {
    GuildConfig: {
      findOneAndUpdate: async (filter, update) => {
        rollbacks.push({ filter, update });
        return { guildId: "g1" };
      },
    },
    guildId: "g1",
    claimedState: { lastKey: "k" },
    previousState: { lastKey: "old" },
  };
  return { claim, rollbacks };
}

test("a claimed post that goes out keeps its claim", async (t) => {
  t.mock.method(console, "log", () => {});
  const { claim, rollbacks } = makeClaim();
  const sent = await sendClaimedPost({ send: async () => ({ id: "m1" }), claim, label: "[test]", detail: "key=k" });
  assert.deepEqual([sent, rollbacks.length], [true, 0]);
});

test("a claimed post that sends nothing releases its claim and says so", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { claim, rollbacks } = makeClaim();
  const sent = await sendClaimedPost({ send: async () => null, claim, label: "[test]", detail: "key=k" });
  assert.equal(sent, false);
  assert.deepEqual(rollbacks.map(({ filter, update }) => [filter, update.$set]), [[{ guildId: "g1", lastKey: "k" }, { lastKey: "old" }]]);
  assert.deepEqual(warn.mock.calls[0].arguments, ["[test] send failed; claim released guild=g1 key=k:", "no message returned"]);
});

test("a retried claimed post waits between attempts and stops when the wait fails", async (t) => {
  t.mock.method(console, "log", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  let sends = 0;
  let waits = 0;
  const first = makeClaim();
  const sent = await sendClaimedPost({
    send: async () => { sends += 1; if (sends === 1) throw new Error("timeout"); return { id: "m1" }; },
    claim: first.claim, label: "[test]", detail: "key=k", attempts: 2,
    waitBeforeRetry: async () => { waits += 1; },
  });
  assert.deepEqual([sent, sends, waits, first.rollbacks.length], [true, 2, 1, 0]);

  const second = makeClaim();
  const stopped = await sendClaimedPost({
    send: async () => { throw new Error("timeout"); },
    claim: second.claim, label: "[test]", detail: "key=k", attempts: 2,
    waitBeforeRetry: async () => { throw new Error("shutting down"); },
  });
  assert.deepEqual([stopped, second.rollbacks.length], [false, 1]);
  assert.equal(warn.mock.calls.at(-1).arguments[1], "shutting down");
});

test("a retried claimed post reports the last attempt, not an earlier error", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { claim } = makeClaim();
  let sends = 0;
  await sendClaimedPost({
    send: async () => { sends += 1; if (sends === 1) throw new Error("timeout"); return null; },
    claim, label: "[test]", detail: "key=k", attempts: 2,
    waitBeforeRetry: async () => {},
  });
  assert.equal(warn.mock.calls[0].arguments[1], "no message returned");
});
