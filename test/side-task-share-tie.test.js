"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveTaskWriteTargetFromAccessible } = require("../bot/utils/raid/tasks/side-tasks");

test("resolveTaskWriteTargetFromAccessible picks the edit share when a view share has the same roster name", () => {
  const share = (ownerDiscordId, accessLevel) => ({
    isOwn: false,
    accountName: "Shared",
    ownerDiscordId,
    ownerLabel: ownerDiscordId,
    accessLevel,
  });

  const result = resolveTaskWriteTargetFromAccessible("grantee", "Shared", [
    share("viewer-owner", "view"),
    share("editor-owner", "edit"),
  ]);

  assert.deepEqual(result, {
    discordId: "editor-owner",
    viaShare: true,
    ownerLabel: "editor-owner",
    accessLevel: "edit",
    canEdit: true,
  });
});
