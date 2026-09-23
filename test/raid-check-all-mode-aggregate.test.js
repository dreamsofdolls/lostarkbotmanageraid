"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAllModePendingAggregateCache,
} = require("../bot/handlers/raid-check/all-mode/all-mode-aggregate");

// Independent scan oracle retained only for parity tests of the indexed runtime path.
const { isSupportClass } = require("../bot/models/Class");
const { getRaidModeLabel } = require("../bot/utils/raid/common/labels");
const { isCountedRaidProgress } = require("../bot/utils/raid/common/character");
const {
  isRaidCheckVisibleCharacter,
  isRaidCheckVisibleRaid,
} = require("../bot/handlers/raid-check/visibility");

function createRoleTally() {
  return { count: 0, supports: 0, dps: 0 };
}

function addPendingRole(tally, isSupport) {
  tally.count += 1;
  if (isSupport) {
    tally.supports += 1;
  } else {
    tally.dps += 1;
  }
}

function getRaidEntry({ perRaidPending, raid, lang }) {
  const key = `${raid.raidKey}:${raid.modeKey}`;
  let entry = perRaidPending.get(key);
  if (!entry) {
    entry = {
      key,
      label: getRaidModeLabel(raid.raidKey, raid.modeKey, lang),
      // raidKey/modeKey kept so the raid dropdown can sort by canonical
      // progression order (compareRaidModeOrder) instead of pending count.
      raidKey: raid.raidKey,
      modeKey: raid.modeKey,
      pending: 0,
      supports: 0,
      dps: 0,
    };
    perRaidPending.set(key, entry);
  }
  return entry;
}

function computeReferenceAggregate({
  pagesData,
  raidFilter = null,
  userFilter = null,
  getStatusRaidsForCharacter,
  lang = "vi",
}) {
  const perUserPending = new Map();
  const perRaidPending = new Map();
  let totalPending = 0;

  for (const page of pagesData || []) {
    const discordId = page?.userDoc?.discordId;
    if (!discordId) continue;
    if (userFilter && discordId !== userFilter) continue;

    const chars = Array.isArray(page?.account?.characters)
      ? page.account.characters
      : [];
    for (const character of chars) {
      if (!isRaidCheckVisibleCharacter(character)) continue;
      const charIsSupport = isSupportClass(character?.class);
      for (const raid of getStatusRaidsForCharacter(character) || []) {
        if (!isRaidCheckVisibleRaid(raid)) continue;
        if (!isCountedRaidProgress(raid)) continue;
        const raidEntry = getRaidEntry({ perRaidPending, raid, lang });
        if (raidFilter && raidEntry.key !== raidFilter) continue;
        if (raid.isCompleted) continue;

        let userEntry = perUserPending.get(discordId);
        if (!userEntry) {
          userEntry = createRoleTally();
          perUserPending.set(discordId, userEntry);
        }

        addPendingRole(userEntry, charIsSupport);
        raidEntry.pending += 1;
        if (charIsSupport) {
          raidEntry.supports += 1;
        } else {
          raidEntry.dps += 1;
        }
        totalPending += 1;
      }
    }
  }

  return { perUserPending, perRaidPending, totalPending };
}

function computePendingAggregate({ raidFilter, userFilter, ...options }) {
  return createAllModePendingAggregateCache(options).compute({ raidFilter, userFilter });
}

function createPage(discordId, characters) {
  return {
    userDoc: { discordId },
    account: { characters },
  };
}

function raid(raidKey, modeKey, isCompleted = false, extras = {}) {
  return { raidKey, modeKey, isCompleted, ...extras };
}

const pagesData = [
  createPage("user-a", [
    {
      class: "Artist",
      itemLevel: 1730,
      raids: [
        raid("act4", "normal"),
        raid("kazeros", "hard", true),
      ],
    },
    {
      class: "Slayer",
      itemLevel: 1730,
      raids: [
        raid("act4", "normal"),
        raid("serca", "hard"),
      ],
    },
  ]),
  createPage("user-b", [
    {
      class: "Bard",
      itemLevel: 1730,
      raids: [raid("act4", "normal")],
    },
  ]),
];

const getStatusRaidsForCharacter = (character) => character.raids;

function normalizeAggregate(aggregate) {
  return {
    totalPending: aggregate.totalPending,
    perUserPending: [...aggregate.perUserPending.entries()]
      .map(([key, value]) => [key, value])
      .sort(([a], [b]) => a.localeCompare(b)),
    perRaidPending: [...aggregate.perRaidPending.entries()]
      .map(([key, value]) => [key, value])
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}

test("raid-check all-mode aggregate counts pending by user, raid, and role bucket", () => {
  const aggregate = computePendingAggregate({
    pagesData,
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 4);

  assert.deepEqual(aggregate.perUserPending.get("user-a"), {
    count: 3,
    supports: 1,
    dps: 2,
  });
  assert.deepEqual(aggregate.perUserPending.get("user-b"), {
    count: 1,
    supports: 1,
    dps: 0,
  });

  const act4 = aggregate.perRaidPending.get("act4:normal");
  assert.equal(act4.pending, 3);
  assert.equal(act4.supports, 2);
  assert.equal(act4.dps, 1);
  assert.match(act4.label, /Normal/);
});

test("raid-check all-mode aggregate keeps completed raid entries visible with zero pending", () => {
  const aggregate = computePendingAggregate({
    pagesData,
    getStatusRaidsForCharacter,
    lang: "en",
  });

  const kazeros = aggregate.perRaidPending.get("kazeros:hard");
  assert.ok(kazeros);
  assert.equal(kazeros.pending, 0);
  assert.equal(kazeros.supports, 0);
  assert.equal(kazeros.dps, 0);
});

test("raid-check all-mode aggregate scopes pending counts by active raid filter", () => {
  const aggregate = computePendingAggregate({
    pagesData,
    raidFilter: "serca:hard",
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.deepEqual(aggregate.perUserPending.get("user-a"), {
    count: 1,
    supports: 0,
    dps: 1,
  });
  assert.equal(aggregate.perUserPending.has("user-b"), false);
});

test("raid-check all-mode aggregate scopes raid dropdown counts by active user filter", () => {
  const aggregate = computePendingAggregate({
    pagesData,
    userFilter: "user-b",
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.equal(aggregate.perRaidPending.get("act4:normal").pending, 1);
  assert.equal(aggregate.perRaidPending.has("serca:hard"), false);
});

test("raid-check all-mode aggregate excludes raids that do not receive gold", () => {
  const aggregate = computePendingAggregate({
    pagesData: [
      createPage("user-a", [
        {
          class: "Artist",
          itemLevel: 1730,
          raids: [
            raid("act4", "hard", false, { goldReceives: false }),
            raid("kazeros", "hard", false, { goldReceives: true }),
          ],
        },
      ]),
      createPage("user-b", [
        {
          class: "Slayer",
          itemLevel: 1730,
          raids: [
            raid("act4", "hard", false, { goldReceives: false }),
          ],
        },
      ]),
    ],
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.deepEqual(aggregate.perUserPending.get("user-a"), {
    count: 1,
    supports: 1,
    dps: 0,
  });
  assert.equal(aggregate.perUserPending.has("user-b"), false);
  assert.equal(aggregate.perRaidPending.has("act4:hard"), false);
  assert.equal(aggregate.perRaidPending.get("kazeros:hard").pending, 1);
});

test("raid-check all-mode aggregate excludes Solo raids even when they receive gold", () => {
  const aggregate = computePendingAggregate({
    pagesData: [
      createPage("user-a", [
        {
          class: "Artist",
          itemLevel: 1730,
          raids: [
            raid("act4", "solo", false, { goldReceives: true }),
            raid("kazeros", "normal", false, { goldReceives: true }),
          ],
        },
      ]),
    ],
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.equal(aggregate.perRaidPending.has("act4:solo"), false);
  assert.equal(aggregate.perRaidPending.get("kazeros:normal").pending, 1);
});

test("raid-check all-mode aggregate cache reuses scans and character raid derivation", () => {
  let raidReads = 0;
  const cache = createAllModePendingAggregateCache({
    pagesData,
    getStatusRaidsForCharacter: (character) => {
      raidReads += 1;
      return character.raids;
    },
    lang: "en",
  });

  const first = cache.compute({ raidFilter: null, userFilter: null });
  const repeated = cache.compute({ raidFilter: null, userFilter: null });
  assert.strictEqual(repeated, first);
  assert.equal(raidReads, 3);

  cache.compute({ raidFilter: "act4:normal", userFilter: null });
  assert.equal(raidReads, 3);

  cache.clear();
  cache.compute({ raidFilter: null, userFilter: null });
  assert.equal(raidReads, 6);
});

test("raid-check all-mode aggregate cache indexes raid rows once across new filters", () => {
  let completionReads = 0;
  const trackedRaid = {
    raidKey: "act4",
    modeKey: "normal",
    goldReceives: true,
    get isCompleted() {
      completionReads += 1;
      return false;
    },
  };
  const trackedPages = [
    createPage("user-a", [{ class: "Artist", itemLevel: 1730, raids: [trackedRaid] }]),
  ];
  const cache = createAllModePendingAggregateCache({
    pagesData: trackedPages,
    getStatusRaidsForCharacter,
    lang: "en",
  });

  cache.compute();
  assert.equal(completionReads, 1);

  cache.compute({ raidFilter: "act4:normal" });
  cache.compute({ userFilter: "user-a" });
  cache.compute({ raidFilter: "act4:normal", userFilter: "user-a" });

  assert.equal(
    completionReads,
    1,
    "new filter combinations should use the session index instead of rescanning raids"
  );
});

test("raid-check all-mode aggregate index matches direct scans for every filter shape", () => {
  const cache = createAllModePendingAggregateCache({
    pagesData,
    getStatusRaidsForCharacter,
    lang: "en",
  });
  const filters = [
    {},
    { raidFilter: "act4:normal" },
    { raidFilter: "serca:hard" },
    { userFilter: "user-a" },
    { userFilter: "user-b" },
    { raidFilter: "act4:normal", userFilter: "user-a" },
    { raidFilter: "missing:hard", userFilter: "user-a" },
    { raidFilter: "act4:normal", userFilter: "missing-user" },
  ];

  for (const filter of filters) {
    const expected = computeReferenceAggregate({
      pagesData,
      ...filter,
      getStatusRaidsForCharacter,
      lang: "en",
    });
    assert.deepEqual(
      normalizeAggregate(cache.compute(filter)),
      normalizeAggregate(expected),
      `indexed aggregate differs for ${JSON.stringify(filter)}`
    );
  }
});

test("raid-check all-mode aggregate leaves out characters below 1720", () => {
  const aggregate = computePendingAggregate({
    pagesData: [
      createPage("user-a", [
        { class: "Slayer", itemLevel: 1730, raids: [raid("act4", "hard")] },
        { class: "Slayer", itemLevel: 1710, raids: [raid("kazeros", "normal")] },
      ]),
    ],
    getStatusRaidsForCharacter,
    lang: "en",
  });

  assert.equal(aggregate.totalPending, 1);
  assert.deepEqual([...aggregate.perRaidPending.keys()], ["act4:hard"]);
});
