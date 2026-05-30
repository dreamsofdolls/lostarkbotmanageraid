const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isStaleEvent,
  purgeStaleRaidEvents,
} = require("../bot/services/raid/schedule/event-cleanup");

const BOUNDARY = Date.UTC(2026, 4, 27, 10, 0); // a Wed 10:00 UTC (= 17:00 VN reset)

test("isStaleEvent: true when startAt is before the reset boundary", () => {
  assert.equal(isStaleEvent({ startAt: new Date(Date.UTC(2026, 4, 25, 13, 0)) }, BOUNDARY), true);  // before reset
  assert.equal(isStaleEvent({ startAt: new Date(Date.UTC(2026, 4, 28, 13, 0)) }, BOUNDARY), false); // after reset
  assert.equal(isStaleEvent({ startAt: new Date(BOUNDARY) }, BOUNDARY), false); // exactly at boundary = this cycle
});

test("isStaleEvent: missing/invalid startAt is not stale (defensive - never delete blindly)", () => {
  assert.equal(isStaleEvent({}, BOUNDARY), false);
  assert.equal(isStaleEvent({ startAt: null }, BOUNDARY), false);
  assert.equal(isStaleEvent(null, BOUNDARY), false);
});

test("purgeStaleRaidEvents deletes boards (best-effort) then the docs by id", async () => {
  const staleDocs = [
    { _id: "e1", channelId: "c1", messageId: "m1" },
    { _id: "e2", channelId: "c2", messageId: null }, // no board to delete
  ];
  let deleteManyArg = null;
  let boardDeletes = 0;
  const RaidEvent = {
    find() {
      return { select() { return { lean: async () => staleDocs }; } };
    },
    async deleteMany(query) {
      deleteManyArg = query;
      return { deletedCount: staleDocs.length };
    },
  };
  const client = {
    channels: {
      async fetch() {
        return {
          messages: {
            async fetch() {
              return { async delete() { boardDeletes += 1; } };
            },
          },
        };
      },
    },
  };

  const result = await purgeStaleRaidEvents({ RaidEvent, client, boundaryMs: BOUNDARY });

  assert.equal(result.deleted, 2);
  assert.equal(result.boardsDeleted, 1);                       // only e1 had a messageId
  assert.deepEqual(deleteManyArg, { _id: { $in: ["e1", "e2"] } });
});

test("purgeStaleRaidEvents is a no-op when nothing is stale", async () => {
  const RaidEvent = {
    find() { return { select() { return { lean: async () => [] }; } }; },
    async deleteMany() { throw new Error("should not be called"); },
  };
  const result = await purgeStaleRaidEvents({ RaidEvent, client: {}, boundaryMs: BOUNDARY });
  assert.deepEqual(result, { deleted: 0, boardsDeleted: 0 });
});
