"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseTaskToggleValue,
  toggleParsedSideTask,
} = require("../bot/handlers/raid-status/task-actions");

function makeUserModel(userDoc) {
  return {
    async findOne(query) {
      assert.equal(query.discordId, "user-1");
      return userDoc;
    },
  };
}

function makeSaveWithRetry() {
  let count = 0;
  return {
    async saveWithRetry(fn) {
      count += 1;
      return fn();
    },
    get count() {
      return count;
    },
  };
}

function makeUserDoc() {
  return {
    accounts: [
      {
        accountName: "Main",
        sharedTasks: [
          {
            taskId: "shared-1",
            name: "Event Shop",
            reset: "weekly",
            completed: false,
          },
        ],
        characters: [
          {
            name: "Aki",
            sideTasks: [
              {
                taskId: "single-1",
                name: "Una",
                reset: "daily",
                completed: false,
              },
              {
                taskId: "bulk-a",
                name: "Chaos",
                reset: "weekly",
                completed: false,
              },
            ],
          },
          {
            name: "Bao",
            sideTasks: [
              {
                taskId: "bulk-b",
                name: "Chaos",
                reset: "weekly",
                completed: false,
              },
            ],
          },
        ],
      },
    ],
    async save() {},
  };
}

function baseOptions(userDoc) {
  const save = makeSaveWithRetry();
  return {
    User: makeUserModel(userDoc),
    saveWithRetry: save.saveWithRetry,
    discordId: "user-1",
    targetAccountName: "Main",
    save,
  };
}

test("toggleParsedSideTask dispatches shared task toggles", async () => {
  const userDoc = makeUserDoc();
  const opts = baseOptions(userDoc);

  const result = await toggleParsedSideTask({
    ...opts,
    parsed: parseTaskToggleValue("shared::shared-1"),
  });

  assert.deepEqual(result, { handled: true, ok: true });
  assert.equal(opts.save.count, 1);
  assert.equal(userDoc.accounts[0].sharedTasks[0].completed, true);
});

test("toggleParsedSideTask dispatches bulk side-task toggles", async () => {
  const userDoc = makeUserDoc();
  const opts = baseOptions(userDoc);

  const result = await toggleParsedSideTask({
    ...opts,
    parsed: parseTaskToggleValue("__all__::weekly::chaos"),
  });

  assert.deepEqual(result, { handled: true, ok: true });
  assert.equal(opts.save.count, 1);
  assert.equal(userDoc.accounts[0].characters[0].sideTasks[1].completed, true);
  assert.equal(userDoc.accounts[0].characters[1].sideTasks[0].completed, true);
});

test("toggleParsedSideTask dispatches single side-task toggles", async () => {
  const userDoc = makeUserDoc();
  const opts = baseOptions(userDoc);

  const result = await toggleParsedSideTask({
    ...opts,
    parsed: parseTaskToggleValue("Aki::single-1"),
  });

  assert.deepEqual(result, { handled: true, ok: true });
  assert.equal(opts.save.count, 1);
  assert.equal(userDoc.accounts[0].characters[0].sideTasks[0].completed, true);
  assert.equal(userDoc.accounts[0].characters[1].sideTasks[0].completed, false);
});

test("toggleParsedSideTask ignores noop and invalid parsed values", async () => {
  const userDoc = makeUserDoc();
  const opts = baseOptions(userDoc);

  assert.deepEqual(
    await toggleParsedSideTask({
      ...opts,
      parsed: { kind: "noop" },
    }),
    { handled: false, ok: false },
  );
  assert.deepEqual(
    await toggleParsedSideTask({
      ...opts,
      parsed: { kind: "invalid" },
    }),
    { handled: false, ok: false },
  );
  assert.equal(opts.save.count, 0);
});

test("toggleParsedSideTask logs handler failures and keeps collector alive", async () => {
  const errors = [];
  const result = await toggleParsedSideTask({
    User: makeUserModel(makeUserDoc()),
    saveWithRetry: async () => {
      throw new Error("mongo offline");
    },
    discordId: "user-1",
    targetAccountName: "Main",
    parsed: parseTaskToggleValue("Aki::single-1"),
    logger: {
      error: (...args) => errors.push(args),
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.message, "mongo offline");
  assert.deepEqual(errors, [
    ["[raid-status side-task toggle] save failed:", "mongo offline"],
  ]);
});
