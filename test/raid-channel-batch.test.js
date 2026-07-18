const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _test: {
    resolveRaidChannelWritePlans,
    resolveRaidChannelWriteBatch,
    applyRaidChannelWritePlans,
    applyRaidChannelUpdatePlans,
    buildWritePlanSegments,
  },
} = require("../bot/services/raid/channel-monitor/channel-monitor");

const silentLogger = {
  warn() {},
  error() {},
  log() {},
};

const raidMeta = {
  raidKey: "kazeros",
  modeKey: "hard",
  label: "Kazeros Hard",
};

test("resolveRaidChannelWritePlans loads accessible accounts once and routes shared chars", async () => {
  let accessLoads = 0;
  const plans = await resolveRaidChannelWritePlans({
    authorId: "viewer-1",
    charNames: ["OwnOne", "SharedOne", "MissingOne"],
    logger: silentLogger,
    getAccessibleAccounts: async (viewerId) => {
      accessLoads += 1;
      assert.equal(viewerId, "viewer-1");
      return [
        {
          ownerDiscordId: "viewer-1",
          accountName: "ViewerRoster",
          isOwn: true,
          accessLevel: "edit",
          account: { characters: [{ charName: "OwnOne" }] },
        },
        {
          ownerDiscordId: "owner-1",
          accountName: "OwnerRoster",
          isOwn: false,
          accessLevel: "edit",
          account: { characters: [{ charName: "SharedOne" }] },
        },
      ];
    },
  });

  assert.equal(accessLoads, 1);
  assert.deepEqual(
    plans.map(({ charName, discordId, executorId, rosterName }) => ({
      charName,
      discordId,
      executorId,
      rosterName,
    })),
    [
      {
        charName: "OwnOne",
        discordId: "viewer-1",
        executorId: null,
        rosterName: null,
      },
      {
        charName: "SharedOne",
        discordId: "owner-1",
        executorId: "viewer-1",
        rosterName: "OwnerRoster",
      },
      {
        charName: "MissingOne",
        discordId: "viewer-1",
        executorId: null,
        rosterName: null,
      },
    ],
  );
});

test("resolveRaidChannelWriteBatch reports every missing character before writes", async () => {
  const batch = await resolveRaidChannelWriteBatch({
    authorId: "viewer-1",
    charNames: ["OwnOne", "MissingOne", "MissingTwo"],
    logger: silentLogger,
    getAccessibleAccounts: async () => [{
      ownerDiscordId: "viewer-1",
      accountName: "ViewerRoster",
      isOwn: true,
      accessLevel: "edit",
      account: { characters: [{ charName: "OwnOne" }] },
    }],
  });

  assert.equal(batch.lookupFailed, false);
  assert.equal(batch.noAccessibleRoster, false);
  assert.deepEqual(batch.missingCharNames, ["MissingOne", "MissingTwo"]);
});

test("applyRaidChannelWritePlans batches consecutive writes by target owner", async () => {
  const plans = [
    { index: 0, charName: "OwnOne", discordId: "viewer-1", executorId: null, rosterName: null },
    { index: 1, charName: "OwnTwo", discordId: "viewer-1", executorId: null, rosterName: null },
    { index: 2, charName: "SharedOne", discordId: "owner-1", executorId: "viewer-1", rosterName: "OwnerRoster" },
    { index: 3, charName: "SharedTwo", discordId: "owner-1", executorId: "viewer-1", rosterName: "OwnerRoster" },
  ];
  const batchCalls = [];
  const singleCalls = [];

  const results = await applyRaidChannelWritePlans({
    plans,
    raidMeta,
    statusType: "process",
    effectiveGates: ["G1", "G2"],
    logger: silentLogger,
    applyRaidSetForDiscordId: async (args) => {
      singleCalls.push(args);
      return { matched: true, updated: true, displayName: args.characterName };
    },
    applyRaidSetBatchForDiscordId: async (args) => {
      batchCalls.push(args);
      return args.entries.map((entry) => ({
        matched: true,
        updated: true,
        displayName: entry.characterName,
      }));
    },
  });

  assert.equal(singleCalls.length, 0);
  assert.equal(batchCalls.length, 2);
  assert.deepEqual(
    batchCalls.map((call) => ({
      discordId: call.discordId,
      entries: call.entries.map(({ characterName, executorId, rosterName }) => ({
        characterName,
        executorId,
        rosterName,
      })),
    })),
    [
      {
        discordId: "viewer-1",
        entries: [
          { characterName: "OwnOne", executorId: null, rosterName: null },
          { characterName: "OwnTwo", executorId: null, rosterName: null },
        ],
      },
      {
        discordId: "owner-1",
        entries: [
          { characterName: "SharedOne", executorId: "viewer-1", rosterName: "OwnerRoster" },
          { characterName: "SharedTwo", executorId: "viewer-1", rosterName: "OwnerRoster" },
        ],
      },
    ],
  );
  assert.deepEqual(
    results.map(({ charName, displayName, updated }) => ({ charName, displayName, updated })),
    [
      { charName: "OwnOne", displayName: "OwnOne", updated: true },
      { charName: "OwnTwo", displayName: "OwnTwo", updated: true },
      { charName: "SharedOne", displayName: "SharedOne", updated: true },
      { charName: "SharedTwo", displayName: "SharedTwo", updated: true },
    ],
  );
});

test("applyRaidChannelUpdatePlans writes the raid-by-character product in one owner batch", async () => {
  const plans = [
    { index: 0, charName: "OwnOne", discordId: "viewer-1", executorId: null, rosterName: null },
    { index: 1, charName: "OwnTwo", discordId: "viewer-1", executorId: null, rosterName: null },
  ];
  const updates = [
    { raidMeta: { ...raidMeta, raidKey: "armoche", label: "Act 4 Hard" }, statusType: "complete", effectiveGates: [] },
    { raidMeta, statusType: "complete", effectiveGates: [] },
  ];
  const batchCalls = [];

  const groups = await applyRaidChannelUpdatePlans({
    plans,
    updates,
    logger: silentLogger,
    applyRaidSetForDiscordId: async () => {
      throw new Error("single path should not run");
    },
    applyRaidSetBatchForDiscordId: async (args) => {
      batchCalls.push(args);
      return args.entries.map((entry) => ({
        matched: true,
        updated: true,
        displayName: entry.characterName,
      }));
    },
  });

  assert.equal(batchCalls.length, 1);
  assert.deepEqual(
    batchCalls[0].entries.map((entry) => `${entry.characterName}:${entry.raidMeta.raidKey}`),
    ["OwnOne:armoche", "OwnOne:kazeros", "OwnTwo:armoche", "OwnTwo:kazeros"]
  );
  assert.deepEqual(groups.map((group) => group.raidMeta.raidKey), ["armoche", "kazeros"]);
  assert.deepEqual(
    groups.map((group) => group.results.map((result) => result.displayName)),
    [["OwnOne", "OwnTwo"], ["OwnOne", "OwnTwo"]]
  );
});

test("applyRaidChannelWritePlans preserves noRoster stop between segments", async () => {
  const plans = [
    { index: 0, charName: "MissingOne", discordId: "viewer-1", executorId: null, rosterName: null },
    { index: 1, charName: "MissingTwo", discordId: "viewer-1", executorId: null, rosterName: null },
    { index: 2, charName: "SharedLater", discordId: "owner-1", executorId: "viewer-1", rosterName: "OwnerRoster" },
  ];
  const batchCalls = [];

  const results = await applyRaidChannelWritePlans({
    plans,
    raidMeta,
    statusType: "complete",
    effectiveGates: [],
    logger: silentLogger,
    applyRaidSetForDiscordId: async () => {
      throw new Error("single path should not run");
    },
    applyRaidSetBatchForDiscordId: async (args) => {
      batchCalls.push(args);
      assert.equal(args.discordId, "viewer-1");
      return args.entries.map(() => ({ noRoster: true, matched: false, updated: false }));
    },
  });

  assert.equal(batchCalls.length, 1);
  assert.deepEqual(results.map((r) => r.charName), ["MissingOne", "MissingTwo"]);
  assert.ok(results.every((r) => r.noRoster));
});

test("buildWritePlanSegments only batches consecutive matching targets", () => {
  const segments = buildWritePlanSegments([
    { discordId: "A", executorId: null, charName: "A1" },
    { discordId: "B", executorId: "A", charName: "B1" },
    { discordId: "A", executorId: null, charName: "A2" },
  ]);

  assert.deepEqual(
    segments.map((segment) => segment.plans.map((plan) => plan.charName)),
    [["A1"], ["B1"], ["A2"]],
  );
});
