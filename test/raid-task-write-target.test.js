"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidTaskWriteTargetResolver,
} = require("../bot/handlers/raid/task/write-target");

test("raid-task write target uses executor doc when no roster is supplied", async () => {
  let ownLookupCount = 0;
  let accessLookupCount = 0;
  const resolveTaskWriteTarget = createRaidTaskWriteTargetResolver({
    loadUserForAutocomplete: async () => {
      ownLookupCount += 1;
      return null;
    },
    getAccessibleAccounts: async () => {
      accessLookupCount += 1;
      return [];
    },
  });

  const result = await resolveTaskWriteTarget("viewer-1", "");

  assert.deepEqual(result, { discordId: "viewer-1", viaShare: false });
  assert.equal(ownLookupCount, 0);
  assert.equal(accessLookupCount, 0);
});

test("raid-task write target gives own roster precedence before shared rosters", async () => {
  let accessLookupCount = 0;
  const resolveTaskWriteTarget = createRaidTaskWriteTargetResolver({
    loadUserForAutocomplete: async () => ({
      accounts: [{ accountName: "Main" }],
    }),
    getAccessibleAccounts: async () => {
      accessLookupCount += 1;
      return [
        {
          isOwn: false,
          accountName: "Main",
          ownerDiscordId: "owner-1",
          ownerLabel: "Owner One",
          accessLevel: "edit",
        },
      ];
    },
  });

  const result = await resolveTaskWriteTarget("viewer-1", "main");

  assert.deepEqual(result, { discordId: "viewer-1", viaShare: false });
  assert.equal(accessLookupCount, 0);
});

test("raid-task write target routes editable shared roster writes to owner", async () => {
  const resolveTaskWriteTarget = createRaidTaskWriteTargetResolver({
    loadUserForAutocomplete: async () => ({ accounts: [] }),
    getAccessibleAccounts: async () => [
      {
        isOwn: false,
        accountName: "Shared",
        ownerDiscordId: "owner-1",
        ownerLabel: "Owner One",
        accessLevel: "edit",
      },
    ],
  });

  const result = await resolveTaskWriteTarget("viewer-1", "shared");

  assert.deepEqual(result, {
    discordId: "owner-1",
    viaShare: true,
    ownerLabel: "Owner One",
    accessLevel: "edit",
    canEdit: true,
  });
});

test("raid-task write target preserves view-only shared roster metadata", async () => {
  const resolveTaskWriteTarget = createRaidTaskWriteTargetResolver({
    loadUserForAutocomplete: async () => ({ accounts: [] }),
    getAccessibleAccounts: async () => [
      {
        isOwn: false,
        accountName: "Shared",
        ownerDiscordId: "owner-1",
        ownerLabel: "Owner One",
        accessLevel: "view",
      },
    ],
  });

  const result = await resolveTaskWriteTarget("viewer-1", "shared");

  assert.deepEqual(result, {
    discordId: "owner-1",
    viaShare: true,
    ownerLabel: "Owner One",
    accessLevel: "view",
    canEdit: false,
  });
});

test("raid-task write target falls back to executor when access lookup fails", async () => {
  const warnings = [];
  const resolveTaskWriteTarget = createRaidTaskWriteTargetResolver({
    loadUserForAutocomplete: async () => ({ accounts: [] }),
    getAccessibleAccounts: async () => {
      throw new Error("network down");
    },
    logger: {
      warn: (...args) => warnings.push(args),
    },
  });

  const result = await resolveTaskWriteTarget("viewer-1", "shared");

  assert.deepEqual(result, { discordId: "viewer-1", viaShare: false });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "[raid-task] getAccessibleAccounts failed:");
  assert.equal(warnings[0][1], "network down");
});
