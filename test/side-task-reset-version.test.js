"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../bot/models/user");
const { createSideTaskResetService } = require("../bot/services/raid/schedulers/side-task-reset");

test("task resets invalidate a loaded User before a roster save can overwrite them", async t => {
  const stale = User.hydrate({
    _id: new mongoose.Types.ObjectId(), __v: 0, discordId: "owner",
    accounts: [{ accountName: "Roster", characters: [{
      id: "character", name: "Alpha", class: "Bard", itemLevel: 1800,
      sideTasks: [{ taskId: "daily", name: "Daily", reset: "daily", completed: true, lastResetAt: 1000 }],
    }] }],
  });
  let storedVersion = stale.__v;
  let resetCalls = 0;
  t.mock.method(User, "updateMany", async (_filter, update) => {
    const modifiedCount = resetCalls++ === 0 ? 1 : 0;
    if (modifiedCount) storedVersion += update.$inc?.__v || 0;
    return { modifiedCount };
  });
  t.mock.method(User.collection, "updateOne", async filter => ({
    acknowledged: true,
    matchedCount: filter.__v === storedVersion ? 1 : 0,
    modifiedCount: filter.__v === storedVersion ? 1 : 0,
  }));

  await createSideTaskResetService({
    User, dailyResetStartMs: () => 2000, weekResetStartMs: () => 0,
  }).resetExpiredSideTasks();
  stale.accounts[0].characters = [stale.accounts[0].characters[0].toObject()];
  stale.accounts[0].characters[0].itemLevel = 1810;

  await assert.rejects(stale.save(), { name: "VersionError" });
});

test("each character and shared-task reset protects optimistic saves", async () => {
  const updates = [];
  await createSideTaskResetService({
    User: { updateMany: async (_filter, update) => { updates.push(update); return { modifiedCount: 1 }; } },
    dailyResetStartMs: () => 2000, weekResetStartMs: () => 3000,
  }).resetExpiredSideTasks();
  assert.equal(updates.length, 4);
  for (const update of updates) assert.equal(update.$inc.__v, 1);
});
