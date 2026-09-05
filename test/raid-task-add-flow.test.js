"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { saveWithRetry } = require("../bot/models/user");
const { clearUserLanguageCache } = require("../bot/services/i18n");
const { createAddSingleHandler } = require("../bot/handlers/raid/task/add/add-single");
const { createAddAllHandler } = require("../bot/handlers/raid/task/add/add-all");
const { createSharedAddHandler } = require("../bot/handlers/raid/task/shared/shared-add");

const factories = { single: createAddSingleHandler, all: createAddAllHandler, shared: createSharedAddHandler };
function harness(kind, { deny = false, allRosters = false, saveError = null, duplicateOnRetry = false } = {}) {
  clearUserLanguageCache();
  const events = [];
  const notices = [];
  const docs = [];
  let saves = 0;
  const handler = factories[kind]({
    User: {
      findOne(query, projection) {
        if (projection) return { lean: async () => ({ language: "en" }) };
        events.push(`read:${query.discordId}`);
        const doc = {
          accounts: [{ accountName: "main", characters: [{ name: "Alpha", sideTasks: [] }], sharedTasks: [] }],
          async save() {
            saves += 1;
            events.push("save");
            if (saveError && saves === 1) throw saveError;
          },
        };
        if (duplicateOnRetry && docs.length) {
          doc.accounts[0].sharedTasks.push({ taskId: "existing", preset: "chaos_gate", name: "Chaos Gate", reset: "scheduled" });
        }
        docs.push(doc);
        return Promise.resolve(doc);
      },
    },
    saveWithRetry,
    dailyResetStartMs: () => 111,
    weekResetStartMs: () => 222,
    resolveTaskWriteTarget: async () => {
      events.push("access");
      return { discordId: "owner", viaShare: true, canEdit: !deny };
    },
    replyViewOnlyShareNotice: async () => { events.push("denied"); },
    replyTaskNotice: async (_interaction, notice) => { events.push("reply"); notices.push(notice); },
  });
  const interaction = {
    user: { id: "executor" },
    options: {
      getString: name => ({ roster: "main", character: "Alpha", name: "Task", reset: "daily", preset: "chaos_gate" })[name] ?? null,
      getBoolean: () => allRosters,
    },
  };
  return { run: () => handler(interaction), events, notices, docs, get saves() { return saves; } };
}

for (const kind of Object.keys(factories)) {
  test(`${kind} add denies a view-only share before loading a writable document`, async () => {
    const state = harness(kind, { deny: true });
    await state.run();
    assert.deepEqual(state.events, ["access", "denied"]);
    assert.equal(state.saves, 0);
  });

  test(`${kind} add retries from fresh state and replies only after the owner's save succeeds`, async () => {
    const state = harness(kind, { saveError: Object.assign(new Error("conflict"), { name: "VersionError" }) });
    await state.run();
    assert.deepEqual(state.events, ["access", "read:owner", "save", "read:owner", "save", "reply"]);
    assert.equal(state.notices[0].type, "success");
    const account = state.docs[1].accounts[0];
    const tasks = kind === "shared" ? account.sharedTasks : account.characters[0].sideTasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].lastResetAt, kind === "shared" ? 0 : 111);
  });

  test(`${kind} add reports a terminal save failure without retrying or announcing success`, async () => {
    const state = harness(kind, { saveError: new Error("offline") });
    await state.run();
    assert.deepEqual(state.events, ["access", "read:owner", "save", "reply"]);
    assert.equal(state.notices.length, 1);
    assert.equal(state.notices[0].type, "error");
  });
}

test("shared all-rosters retry reports only committed rosters and never expands a share", async () => {
  const state = harness("shared", { allRosters: true, saveError: Object.assign(new Error("conflict"), { name: "VersionError" }) });
  await state.run();
  assert.deepEqual(state.events, ["read:executor", "save", "read:executor", "save", "reply"]);
  assert.equal(state.notices[0].type, "success");
  assert.ok(!state.notices[0].description.includes("main, main"), "a failed attempt must not contribute roster names");
});

test("shared retry skips a task added concurrently without saving or retaining failed additions", async () => {
  const state = harness("shared", {
    allRosters: true, duplicateOnRetry: true,
    saveError: Object.assign(new Error("conflict"), { name: "VersionError" }),
  });
  await state.run();
  assert.deepEqual(state.events, ["read:executor", "save", "read:executor", "reply"]);
  assert.equal(state.notices[0].type, "info");
  assert.equal(state.docs[1].accounts[0].sharedTasks.length, 1);
});
