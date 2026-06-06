"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAllModePagesData,
  canRefreshAllModeUsers,
  loadAllModeUsers,
  resolveAllModeAuthorMeta,
  toPlainUserDoc,
} = require("../bot/handlers/raid-check/all-mode/all-mode-data");

function createQuery({ leanRows, awaitedRows, onSelect }) {
  return {
    selected: null,
    select(fields) {
      this.selected = fields;
      onSelect?.(fields);
      return this;
    },
    async lean() {
      return leanRows;
    },
    then(resolve, reject) {
      return Promise.resolve(awaitedRows).then(resolve, reject);
    },
  };
}

test("all-mode data helper converts mongoose-like docs to plain objects", () => {
  const doc = {
    toObject: () => ({ discordId: "100" }),
  };

  assert.deepEqual(toPlainUserDoc(doc), { discordId: "100" });
  assert.equal(toPlainUserDoc(null), null);
  assert.deepEqual(toPlainUserDoc({ discordId: "200" }), { discordId: "200" });
});

test("all-mode data loader uses lean query and fresh-week fallback without refresh deps", async () => {
  const ensured = [];
  let selected = null;
  const rows = [
    { discordId: "100", accounts: [{ accountName: "A" }] },
    { discordId: "200", accounts: [{ accountName: "B" }] },
  ];
  const User = {
    find: (query) => {
      assert.deepEqual(query, { "accounts.0": { $exists: true } });
      return createQuery({
        leanRows: rows,
        awaitedRows: [],
        onSelect: (fields) => {
          selected = fields;
        },
      });
    },
  };

  const result = await loadAllModeUsers({
    User,
    ensureFreshWeek: (user) => ensured.push(user.discordId),
    RAID_CHECK_USER_QUERY_FIELDS: "accounts discordId",
    raidCheckRefreshLimiter: null,
    loadFreshUserSnapshotForRaidViews: null,
    shouldLoadFreshUserSnapshotForRaidViews: null,
  });

  assert.equal(selected, "accounts discordId");
  assert.deepEqual(result.users, rows);
  assert.deepEqual(ensured, ["100", "200"]);
  assert.equal(result.canRefreshFreshData, false);
});

test("all-mode data loader refreshes queued docs and bypasses fresh docs", async () => {
  const limiterCalls = [];
  const seedUsers = [
    {
      discordId: "100",
      shouldRefresh: true,
      toObject: () => ({ discordId: "100-plain" }),
    },
    {
      discordId: "200",
      shouldRefresh: false,
      toObject: () => ({ discordId: "200-plain" }),
    },
  ];
  const User = {
    find: () =>
      createQuery({
        leanRows: [],
        awaitedRows: seedUsers,
      }),
  };

  const result = await loadAllModeUsers({
    User,
    ensureFreshWeek: () => {
      throw new Error("ensureFreshWeek should not run on refresh path");
    },
    RAID_CHECK_USER_QUERY_FIELDS: "fields",
    raidCheckRefreshLimiter: {
      run: async (fn) => {
        limiterCalls.push("run");
        return fn();
      },
    },
    loadFreshUserSnapshotForRaidViews: async (doc, opts) => ({
      discordId: `${doc.discordId}-fresh`,
      opts,
    }),
    shouldLoadFreshUserSnapshotForRaidViews: (doc, opts) => {
      assert.deepEqual(opts, { allowAutoManage: false });
      return doc.shouldRefresh;
    },
  });

  assert.equal(canRefreshAllModeUsers({
    raidCheckRefreshLimiter: { run: () => {} },
    loadFreshUserSnapshotForRaidViews: () => {},
  }), true);
  assert.deepEqual(limiterCalls, ["run"]);
  assert.equal(result.refreshQueued, 1);
  assert.equal(result.freshBypass, 1);
  assert.equal(result.canRefreshFreshData, true);
  assert.deepEqual(result.users, [
    {
      discordId: "100-fresh",
      opts: { allowAutoManage: false, logLabel: "[raid-check all]" },
    },
    { discordId: "200-plain" },
  ]);
});

test("all-mode data builds one page per user account", () => {
  const pages = buildAllModePagesData([
    {
      discordId: "100",
      accounts: [{ accountName: "A" }, { accountName: "B" }],
    },
    {
      discordId: "200",
      accounts: [{ accountName: "C" }],
    },
  ]);

  assert.deepEqual(
    pages.map((page) => [page.userDoc.discordId, page.account.accountName, page.accountIdx]),
    [
      ["100", "A", 0],
      ["100", "B", 1],
      ["200", "C", 0],
    ]
  );
});

test("all-mode data resolves author meta from cache, fetch, and cached doc names", async () => {
  const fetched = [];
  const users = [
    {
      discordId: "100",
      discordDisplayName: "Cached Name",
      accounts: [{ accountName: "A" }],
    },
    {
      discordId: "200",
      accounts: [{ accountName: "B" }],
    },
  ];
  const pagesData = buildAllModePagesData(users);
  const interaction = {
    client: {
      users: {
        cache: new Map([
          [
            "100",
            {
              username: "Ignored Cache Username",
              displayAvatarURL: () => "avatar-100",
            },
          ],
        ]),
        fetch: async (discordId) => {
          fetched.push(discordId);
          return {
            username: `Fetched ${discordId}`,
            displayAvatarURL: () => `avatar-${discordId}`,
          };
        },
      },
    },
  };

  const { visibleUserIds, authorMeta } = await resolveAllModeAuthorMeta({
    interaction,
    users,
    pagesData,
    discordUserLimiter: {
      run: (fn) => fn(),
    },
  });

  assert.deepEqual(visibleUserIds, ["100", "200"]);
  assert.deepEqual(fetched, ["200"]);
  assert.deepEqual(authorMeta.get("100"), {
    displayName: "Cached Name",
    avatarURL: "avatar-100",
  });
  assert.deepEqual(authorMeta.get("200"), {
    displayName: "Fetched 200",
    avatarURL: "avatar-200",
  });
});
