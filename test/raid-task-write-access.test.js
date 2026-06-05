const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveEditableTaskWriteAccess,
} = require("../bot/handlers/raid/task/write-access");

test("raid-task write access passes own roster without logging", async () => {
  const logs = [];
  const access = await resolveEditableTaskWriteAccess({
    executorId: "viewer",
    rosterName: "Main",
    commandName: "add-single",
    resolveTaskWriteTarget: async () => ({ discordId: "viewer", viaShare: false }),
    logger: (line) => logs.push(line),
  });

  assert.deepEqual(access, {
    ok: true,
    writeTarget: { discordId: "viewer", viaShare: false },
    discordId: "viewer",
  });
  assert.deepEqual(logs, []);
});

test("raid-task write access logs editable shared roster owner", async () => {
  const logs = [];
  const access = await resolveEditableTaskWriteAccess({
    executorId: "viewer",
    rosterName: "Main",
    commandName: "shared-add",
    resolveTaskWriteTarget: async () => ({
      discordId: "owner",
      viaShare: true,
      canEdit: true,
    }),
    logger: (line) => logs.push(line),
  });

  assert.equal(access.ok, true);
  assert.equal(access.discordId, "owner");
  assert.deepEqual(logs, [
    "[raid-task] share-write executor=viewer owner=owner cmd=shared-add roster=Main",
  ]);
});

test("raid-task write access rejects view-only shared roster", async () => {
  let deniedTarget = null;
  const logs = [];
  const access = await resolveEditableTaskWriteAccess({
    executorId: "viewer",
    rosterName: "Main",
    commandName: "remove",
    resolveTaskWriteTarget: async () => ({
      discordId: "owner",
      viaShare: true,
      canEdit: false,
      ownerLabel: "Owner One",
    }),
    denyViewOnly: async (target) => {
      deniedTarget = target;
    },
    logger: (line) => logs.push(line),
  });

  assert.equal(access.ok, false);
  assert.equal(access.discordId, "owner");
  assert.equal(deniedTarget.ownerLabel, "Owner One");
  assert.deepEqual(logs, []);
});

test("raid-task write access supports preview log labels", async () => {
  const logs = [];
  await resolveEditableTaskWriteAccess({
    executorId: "viewer",
    rosterName: "Main",
    commandName: "clear",
    logKind: "share-preview",
    resolveTaskWriteTarget: async () => ({
      discordId: "owner",
      viaShare: true,
      canEdit: true,
    }),
    logger: (line) => logs.push(line),
  });

  assert.deepEqual(logs, [
    "[raid-task] share-preview executor=viewer owner=owner cmd=clear roster=Main",
  ]);
});
