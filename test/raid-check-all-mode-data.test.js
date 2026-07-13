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
  assert.deepEqual(await result.startBackgroundRefresh(), []);
});

test("all-mode data loader queues stale refreshes without blocking the render snapshot", async () => {
  const limiterCalls = [];
  const ensured = [];
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
    ensureFreshWeek: (doc) => ensured.push(doc.discordId),
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
  assert.deepEqual(limiterCalls, []);
  assert.equal(result.refreshQueued, 1);
  assert.equal(result.freshBypass, 1);
  assert.equal(result.canRefreshFreshData, true);
  assert.deepEqual(result.users, [
    { discordId: "100-plain" },
    { discordId: "200-plain" },
  ]);
  assert.deepEqual(ensured, ["100-plain", "200-plain"]);

  const firstRefresh = result.startBackgroundRefresh();
  const secondRefresh = result.startBackgroundRefresh();
  assert.equal(firstRefresh, secondRefresh);
  assert.deepEqual(await firstRefresh, [
    {
      discordId: "100-fresh",
      opts: { allowAutoManage: false, logLabel: "[raid-check all]" },
    },
  ]);
  assert.deepEqual(limiterCalls, ["run"]);
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

test("all-mode author meta never waits on Discord REST before first render", async () => {
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
  });

  assert.deepEqual(visibleUserIds, ["100", "200"]);
  assert.deepEqual(fetched, []);
  assert.deepEqual(authorMeta.get("100"), {
    displayName: "Cached Name",
    avatarURL: "avatar-100",
  });
  assert.deepEqual(authorMeta.get("200"), {
    displayName: "200",
    avatarURL: null,
  });
});

test("all-mode author meta skips Discord REST when Mongo already has a display name", async () => {
  const fetched = [];
  const users = [
    {
      discordId: "300",
      discordDisplayName: "Persisted Name",
      accounts: [{ accountName: "C" }],
    },
  ];
  const pagesData = buildAllModePagesData(users);
  const interaction = {
    client: {
      users: {
        cache: new Map(),
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

  const { authorMeta } = await resolveAllModeAuthorMeta({
    interaction,
    users,
    pagesData,
  });

  assert.deepEqual(fetched, []);
  assert.deepEqual(authorMeta.get("300"), {
    displayName: "Persisted Name",
    avatarURL: null,
  });
});

test("all-mode author meta prefers a cached guild nickname without using REST", () => {
  const users = [{ discordId: "400", accounts: [{ accountName: "D" }] }];
  const pagesData = buildAllModePagesData(users);
  const interaction = {
    guild: {
      members: {
        cache: new Map([
          [
            "400",
            {
              displayName: "Guild Nickname",
              displayAvatarURL: () => "guild-avatar-400",
              user: { username: "discord-user-400" },
            },
          ],
        ]),
        fetch: async () => {
          throw new Error("REST should not be needed");
        },
      },
    },
    client: { users: { cache: new Map() } },
  };

  const { authorMeta } = resolveAllModeAuthorMeta({ interaction, users, pagesData });

  assert.deepEqual(authorMeta.get("400"), {
    displayName: "Guild Nickname",
    avatarURL: "guild-avatar-400",
  });
});

test("all-mode author meta hydrates an unresolved numeric label in the background", async () => {
  const fetched = [];
  const users = [
    {
      discordId: "500",
      discordDisplayName: "500",
      accounts: [{ accountName: "E" }],
    },
  ];
  const pagesData = buildAllModePagesData(users);
  const interaction = {
    guild: {
      members: {
        cache: new Map(),
        fetch: async ({ user }) => {
          fetched.push(user);
          return {
            displayName: "Fetched Guild Name",
            displayAvatarURL: () => "guild-avatar-500",
            user: { username: "discord-user-500" },
          };
        },
      },
    },
    client: {
      users: {
        cache: new Map(),
        fetch: async () => {
          throw new Error("guild member fetch should resolve first");
        },
      },
    },
  };

  const { authorMeta, refreshMissingAuthorMeta } = resolveAllModeAuthorMeta({
    interaction,
    users,
    pagesData,
  });

  assert.equal(authorMeta.get("500").displayName, "500");
  assert.equal(await refreshMissingAuthorMeta(), 1);
  assert.equal(await refreshMissingAuthorMeta(), 1);
  assert.deepEqual(fetched, ["500"]);
  assert.deepEqual(authorMeta.get("500"), {
    displayName: "Fetched Guild Name",
    avatarURL: "guild-avatar-500",
  });
});
