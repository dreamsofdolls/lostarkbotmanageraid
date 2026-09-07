const test = require("node:test");
const assert = require("node:assert/strict");

const {
  purgeStaleRaidEvents,
} = require("../bot/services/raid/schedule/lifecycle/event-cleanup");

const BOUNDARY = Date.UTC(2026, 4, 27, 10, 0); // a Wed 10:00 UTC (= 17:00 VN reset)

test("purge query uses an exclusive weekly boundary and disables abandoned cleanup without a finite clock", async () => {
  for (const nowMs of [undefined, NaN, Infinity]) {
    let findQuery;
    const RaidEvent = {
      find(query) {
        findQuery = query;
        return { select() { return { lean: async () => [] }; } };
      },
      async deleteOne() { assert.fail("empty query results must not delete records"); },
    };
    await purgeStaleRaidEvents({ RaidEvent, client: {}, boundaryMs: BOUNDARY, nowMs });
    assert.deepEqual(findQuery, { startAt: { $lt: new Date(BOUNDARY) } });
  }
});

test("purgeStaleRaidEvents query carries the 24h-not-cleared rule when nowMs is given", async () => {
  let findQuery = null;
  const RaidEvent = {
    find(q) { findQuery = q; return { select() { return { lean: async () => [] }; } }; },
    async deleteMany() { return { deletedCount: 0 }; },
  };
  const now = Date.UTC(2026, 4, 31, 0, 0);
  await purgeStaleRaidEvents({ RaidEvent, client: {}, boundaryMs: BOUNDARY, nowMs: now });
  assert.ok(Array.isArray(findQuery.$or), "query uses $or when both rules apply");
  const abandoned = findQuery.$or.find((c) => c.status);
  assert.deepEqual(abandoned.status, { $ne: "cleared" });
  assert.equal(abandoned.startAt.$lt.getTime(), now - 24 * 3600 * 1000);
});

test("purgeStaleRaidEvents deletes docs first, then boards by id", async () => {
  const staleDocs = [
    { _id: "e1", channelId: "c1", messageId: "m1" },
    { _id: "e2", channelId: "c2", messageId: null }, // no board to delete
  ];
  const deleteArgs = [];
  let boardDeletes = 0;
  const order = [];
  const RaidEvent = {
    find() {
      return { select() { return { lean: async () => staleDocs }; } };
    },
    async deleteOne(query) {
      order.push(`docs:${query._id}`);
      deleteArgs.push(query);
      return { deletedCount: 1 };
    },
  };
  const client = {
    channels: {
      async fetch() {
        return {
          messages: {
            async fetch() {
              return { async delete() { order.push("board"); boardDeletes += 1; } };
            },
          },
        };
      },
    },
  };

  const result = await purgeStaleRaidEvents({ RaidEvent, client, boundaryMs: BOUNDARY });

  assert.equal(result.deleted, 2);
  assert.equal(result.boardsDeleted, 1);                       // only e1 had a messageId
  assert.equal(boardDeletes, 1);
  assert.deepEqual(deleteArgs.map((q) => q._id), ["e1", "e2"]);
  assert.equal(deleteArgs[0].startAt.$lt.getTime(), BOUNDARY);
  assert.equal(deleteArgs[1].startAt.$lt.getTime(), BOUNDARY);
  assert.deepEqual(order, ["docs:e1", "docs:e2", "board"]);
});

test("purgeStaleRaidEvents is a no-op when nothing is stale", async () => {
  const RaidEvent = {
    find() { return { select() { return { lean: async () => [] }; } }; },
    async deleteOne() { throw new Error("should not be called"); },
  };
  const result = await purgeStaleRaidEvents({ RaidEvent, client: {}, boundaryMs: BOUNDARY });
  assert.deepEqual(result, { deleted: 0, boardsDeleted: 0 });
});

test("purgeStaleRaidEvents leaves boards alone when doc deletion fails", async () => {
  const staleDocs = [{ _id: "e1", channelId: "c1", messageId: "m1" }];
  let boardDeletes = 0;
  const RaidEvent = {
    find() { return { select() { return { lean: async () => staleDocs }; } }; },
    async deleteOne() { throw new Error("mongo offline"); },
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

  assert.deepEqual(result, { deleted: 0, boardsDeleted: 0 });
  assert.equal(boardDeletes, 0);
});

test("purgeStaleRaidEvents still cleans boards for docs deleted before a later delete failure", async () => {
  const staleDocs = [
    { _id: "e1", channelId: "c1", messageId: "m1" },
    { _id: "e2", channelId: "c2", messageId: "m2" },
  ];
  let boardDeletes = 0;
  const RaidEvent = {
    find() { return { select() { return { lean: async () => staleDocs }; } }; },
    async deleteOne(query) {
      if (query._id === "e2") throw new Error("mongo hiccup");
      return { deletedCount: 1 };
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

  assert.deepEqual(result, { deleted: 1, boardsDeleted: 1 });
  assert.equal(boardDeletes, 1);
});

test("purgeStaleRaidEvents skips board delete when guarded doc delete no longer matches", async () => {
  const staleDocs = [{ _id: "e1", channelId: "c1", messageId: "m1" }];
  let deleteArg = null;
  let boardDeletes = 0;
  const now = Date.UTC(2026, 4, 31, 0, 0);
  const RaidEvent = {
    find() { return { select() { return { lean: async () => staleDocs }; } }; },
    async deleteOne(query) {
      deleteArg = query;
      return { deletedCount: 0 }; // e.g. lead just Ended it to "cleared"
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

  const result = await purgeStaleRaidEvents({ RaidEvent, client, boundaryMs: BOUNDARY, nowMs: now });

  assert.deepEqual(result, { deleted: 0, boardsDeleted: 0 });
  assert.equal(boardDeletes, 0);
  assert.equal(deleteArg._id, "e1");
  assert.ok(Array.isArray(deleteArg.$or), "delete is guarded by the stale query, not only _id");
});
