const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getAccessibleAccounts,
  canEditAccount,
  findAccessibleCharacter,
} = require("../bot/services/access/access-control");

// Lightweight in-memory fakes for User + RosterShare so the service
// tests don't need a real Mongo. Each fake mirrors only the surface
// access-control.js actually uses (findOne, find, lean()).
function buildFakeUser(records) {
  const byId = new Map(records.map((r) => [r.discordId, r]));
  return {
    async findOne(query) {
      if (!query?.discordId) return null;
      return byId.get(query.discordId) || null;
    },
    find(query) {
      const ids = query?.discordId?.$in || [];
      const matched = ids.map((id) => byId.get(id)).filter(Boolean);
      return Promise.resolve(matched);
    },
  };
}

function buildFakeRosterShare(records) {
  return {
    find(query) {
      let matched = records;
      if (query?.granteeDiscordId) {
        matched = matched.filter((r) => r.granteeDiscordId === query.granteeDiscordId);
      }
      if (query?.ownerDiscordId) {
        matched = matched.filter((r) => r.ownerDiscordId === query.ownerDiscordId);
      }
      return {
        async lean() {
          return matched.map((r) => ({ ...r }));
        },
      };
    },
    findOne(query) {
      // Mongoose Query is chainable: caller does `findOne(...).lean()`.
      // Returning a plain object with `.lean()` mirrors that shape; we
      // intentionally don't make findOne async so .lean() is reachable
      // on the returned reference (an awaited Promise would not be).
      const matched = records.find((r) => {
        if (query.ownerDiscordId && r.ownerDiscordId !== query.ownerDiscordId) return false;
        if (query.granteeDiscordId && r.granteeDiscordId !== query.granteeDiscordId) return false;
        if (query.accessLevel && r.accessLevel !== query.accessLevel) return false;
        return true;
      });
      return {
        async lean() {
          return matched ? { ...matched } : null;
        },
      };
    },
  };
}

const ownAccount = (name) => ({ accountName: name, characters: [] });
const sharedRecord = (owner, grantee, level = "edit") => ({
  ownerDiscordId: owner,
  granteeDiscordId: grantee,
  accessLevel: level,
});

test("getAccessibleAccounts returns viewer's own accounts when no shares exist", async () => {
  const User = buildFakeUser([
    {
      discordId: "B",
      discordDisplayName: "Bao",
      accounts: [ownAccount("BaoMain"), ownAccount("BaoAlt")],
    },
  ]);
  const RosterShare = buildFakeRosterShare([]);

  const accessible = await getAccessibleAccounts("B", {
    models: { User, RosterShare },
    helpers: { isManagerId: () => false },
  });

  assert.equal(accessible.length, 2);
  assert.deepEqual(
    accessible.map((entry) => entry.accountName),
    ["BaoMain", "BaoAlt"]
  );
  assert.ok(accessible.every((entry) => entry.isOwn === true));
  assert.ok(accessible.every((entry) => entry.accessLevel === "edit"));
});

test("getAccessibleAccounts merges shared accounts when manager A has granted access", async () => {
  const User = buildFakeUser([
    {
      discordId: "A",
      discordDisplayName: "Alice",
      accounts: [ownAccount("AliceMain")],
    },
    {
      discordId: "B",
      discordDisplayName: "Bao",
      accounts: [ownAccount("BaoMain")],
    },
  ]);
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "edit")]);
  const isManagerId = (id) => id === "A";

  const accessible = await getAccessibleAccounts("B", {
    models: { User, RosterShare },
    helpers: { isManagerId },
  });

  assert.equal(accessible.length, 2);
  const own = accessible.find((entry) => entry.isOwn);
  const shared = accessible.find((entry) => !entry.isOwn);
  assert.equal(own.accountName, "BaoMain");
  assert.equal(shared.accountName, "AliceMain");
  assert.equal(shared.ownerDiscordId, "A");
  assert.equal(shared.ownerLabel, "Alice");
  assert.equal(shared.accessLevel, "edit");
});

test("getAccessibleAccounts auto-suspends shares when owner is no longer manager", async () => {
  const User = buildFakeUser([
    {
      discordId: "A",
      accounts: [ownAccount("AliceMain")],
    },
    {
      discordId: "B",
      accounts: [ownAccount("BaoMain")],
    },
  ]);
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "edit")]);
  // A is NOT in RAID_MANAGER_ID -> share should be filtered out without
  // touching the underlying RosterShare document.
  const isManagerId = () => false;

  const accessible = await getAccessibleAccounts("B", {
    models: { User, RosterShare },
    helpers: { isManagerId },
  });

  assert.equal(accessible.length, 1);
  assert.equal(accessible[0].accountName, "BaoMain");
  assert.equal(accessible[0].isOwn, true);
});

test("getAccessibleAccounts honors view-level access on shared rosters", async () => {
  const User = buildFakeUser([
    { discordId: "A", accounts: [ownAccount("AliceMain")] },
    { discordId: "B", accounts: [] },
  ]);
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "view")]);

  const accessible = await getAccessibleAccounts("B", {
    models: { User, RosterShare },
    helpers: { isManagerId: () => true },
  });

  const shared = accessible.find((entry) => !entry.isOwn);
  assert.ok(shared, "expected the shared account to surface");
  assert.equal(shared.accessLevel, "view");
});

test("getAccessibleAccounts can skip own roster fetch when caller only needs shares", async () => {
  let ownFetches = 0;
  const baseUser = buildFakeUser([
    { discordId: "A", accounts: [ownAccount("AliceMain")] },
    { discordId: "B", accounts: [ownAccount("BaoMain")] },
  ]);
  const User = {
    async findOne(query) {
      if (query?.discordId === "B") ownFetches += 1;
      return baseUser.findOne(query);
    },
    find: baseUser.find,
  };
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "view")]);

  const accessible = await getAccessibleAccounts("B", {
    models: { User, RosterShare },
    helpers: { isManagerId: (id) => id === "A" },
    includeOwn: false,
  });

  assert.equal(ownFetches, 0);
  assert.equal(accessible.length, 1);
  assert.equal(accessible[0].accountName, "AliceMain");
  assert.equal(accessible[0].isOwn, false);
});

test("canEditAccount returns true for the owner short-circuit", async () => {
  const allow = await canEditAccount("B", "B", {
    models: { RosterShare: buildFakeRosterShare([]) },
    helpers: { isManagerId: () => true },
  });
  assert.equal(allow, true);
});

test("canEditAccount returns true when an edit-level share exists", async () => {
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "edit")]);
  const allow = await canEditAccount("B", "A", {
    models: { RosterShare },
    helpers: { isManagerId: (id) => id === "A" },
  });
  assert.equal(allow, true);
});

test("canEditAccount returns false when the share is view-only", async () => {
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "view")]);
  const allow = await canEditAccount("B", "A", {
    models: { RosterShare },
    helpers: { isManagerId: (id) => id === "A" },
  });
  assert.equal(allow, false);
});

test("canEditAccount returns false when owner is no longer in RAID_MANAGER_ID", async () => {
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "edit")]);
  const allow = await canEditAccount("B", "A", {
    models: { RosterShare },
    helpers: { isManagerId: () => false },
  });
  assert.equal(allow, false);
});

test("findAccessibleCharacter resolves a char by name across own + shared rosters", async () => {
  const User = buildFakeUser([
    {
      discordId: "A",
      discordDisplayName: "Alice",
      accounts: [
        {
          accountName: "AliceMain",
          characters: [{ charName: "AlphaChar" }, { charName: "BetaChar" }],
        },
      ],
    },
    {
      discordId: "B",
      accounts: [
        {
          accountName: "BaoMain",
          characters: [{ charName: "MyOwnChar" }],
        },
      ],
    },
  ]);
  const RosterShare = buildFakeRosterShare([sharedRecord("A", "B", "edit")]);
  const helpers = { isManagerId: () => true };

  const own = await findAccessibleCharacter("B", "MyOwnChar", {
    models: { User, RosterShare },
    helpers,
  });
  assert.ok(own, "expected to resolve B's own char");
  assert.equal(own.isOwn, true);
  assert.equal(own.character.charName, "MyOwnChar");

  const shared = await findAccessibleCharacter("B", "BetaChar", {
    models: { User, RosterShare },
    helpers,
  });
  assert.ok(shared, "expected to resolve A's char via share");
  assert.equal(shared.isOwn, false);
  assert.equal(shared.ownerDiscordId, "A");
  assert.equal(shared.character.charName, "BetaChar");

  const missing = await findAccessibleCharacter("B", "NobodyChar", {
    models: { User, RosterShare },
    helpers,
  });
  assert.equal(missing, null);
});
