process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAutoManageCoreService } = require("../bot/services/auto-manage/core");
const { UI, normalizeName, toModeLabel, getCharacterName, getCharacterClass } = require("../bot/utils/raid/common/shared");
const { getRaidGateForBoss, getGatesForRaid } = require("../bot/models/Raid");
const {
  ensureAssignedRaids,
  normalizeAssignedRaid,
  RAID_REQUIREMENT_MAP,
} = require("../bot/utils/raid/common/character");

function makeService(overrides = {}) {
  return createAutoManageCoreService({
    EmbedBuilder: class {},
    UI,
    User: {
      findOne: () => ({ lean: async () => null }),
    },
    saveWithRetry: async (op) => op(),
    ensureFreshWeek: () => false,
    normalizeName,
    toModeLabel,
    getCharacterName,
    getCharacterClass,
    fetchRosterCharacters: async () => [],
    buildFetchedRosterIndexes: () => ({}),
    findFetchedRosterMatchForCharacter: () => null,
    getRaidGateForBoss,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    normalizeAssignedRaid,
    ensureAssignedRaids,
    bibleLimiter: { run: async (op) => op() },
    ...overrides,
  });
}

function makeUserDoc(assignedRaids) {
  return {
    accounts: [
      {
        accountName: "Roster",
        characters: [
          {
            name: "Aki",
            class: "Artist",
            itemLevel: 1750,
            assignedRaids,
          },
        ],
      },
    ],
  };
}

test("auto-manage apply keeps existing modeKey when current sync has no clear logs", () => {
  const service = makeService();
  const userDoc = makeUserDoc({
    kazeros: {
      modeKey: "hard",
      G1: { difficulty: "Hard", completedDate: null },
      G2: { difficulty: "Hard", completedDate: null },
    },
  });

  const report = service.applyAutoManageCollected(userDoc, 1000, [
    {
      entryKey: service.autoManageEntryKey("Roster", "Aki"),
      logs: [],
    },
  ]);

  const kaz = userDoc.accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(report.appliedTotal, 0);
  assert.equal(kaz.modeKey, "hard");
  assert.equal(kaz.G1.difficulty, "Hard");
  assert.equal(kaz.G2.difficulty, "Hard");
});

test("auto-manage apply changes modeKey only when a clear log arrives in the new mode", () => {
  const service = makeService();
  const userDoc = makeUserDoc({
    kazeros: {
      modeKey: "hard",
      G1: { difficulty: "Hard", completedDate: null },
      G2: { difficulty: "Hard", completedDate: null },
    },
  });

  const report = service.applyAutoManageCollected(userDoc, 1000, [
    {
      entryKey: service.autoManageEntryKey("Roster", "Aki"),
      logs: [
        { boss: "Abyss Lord Kazeros", difficulty: "Normal", timestamp: 2000 },
        { boss: "Archdemon Kazeros", difficulty: "Normal", timestamp: 3000 },
      ],
    },
  ]);

  const kaz = userDoc.accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(report.appliedTotal, 2);
  assert.equal(kaz.modeKey, "normal");
  assert.equal(kaz.G1.difficulty, "Normal");
  assert.equal(kaz.G2.difficulty, "Normal");
  assert.equal(kaz.G1.completedDate, 2000);
  assert.equal(kaz.G2.completedDate, 3000);
});

test("auto-manage apply treats a later gate clear as completion of earlier gates", () => {
  const service = makeService();
  const userDoc = makeUserDoc({
    armoche: {
      modeKey: "hard",
      G1: { difficulty: "Hard", completedDate: null },
      G2: { difficulty: "Hard", completedDate: null },
    },
  });

  const report = service.applyAutoManageCollected(userDoc, 1000, [
    {
      entryKey: service.autoManageEntryKey("Roster", "Aki"),
      logs: [
        { boss: "Armoche, Sentinel of the Abyss", difficulty: "Hard", timestamp: 3000 },
      ],
    },
  ]);

  const act4 = userDoc.accounts[0].characters[0].assignedRaids.armoche;
  assert.equal(report.appliedTotal, 2);
  assert.deepEqual(report.perChar[0].applied.map((entry) => entry.gate), ["G1", "G2"]);
  assert.equal(report.perChar[0].applied[0].inferred, true);
  assert.equal(report.perChar[0].applied[1].inferred, false);
  assert.equal(act4.modeKey, "hard");
  assert.equal(act4.G1.difficulty, "Hard");
  assert.equal(act4.G2.difficulty, "Hard");
  assert.equal(act4.G1.completedDate, 3000);
  assert.equal(act4.G2.completedDate, 3000);
});

function createTestLimiter(limit) {
  let active = 0;
  let maxActive = 0;
  let runCalls = 0;
  const queue = [];

  function pump() {
    while (active < limit && queue.length > 0) {
      const { op, resolve, reject } = queue.shift();
      active += 1;
      maxActive = Math.max(maxActive, active);
      Promise.resolve()
        .then(op)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    run(op) {
      runCalls += 1;
      return new Promise((resolve, reject) => {
        queue.push({ op, resolve, reject });
        pump();
      });
    },
    get maxActive() {
      return maxActive;
    },
    get runCalls() {
      return runCalls;
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred() {
  let settled = false;
  let resolve;
  const promise = new Promise((res) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      res(value);
    };
  });
  return { promise, resolve };
}

function emptyBibleResponse() {
  return {
    ok: true,
    json: async () => [],
  };
}

function testRosterWithCachedBibleIds() {
  return {
    accounts: [
      {
        accountName: "Roster",
        characters: [
          { name: "Aki", class: "Artist", bibleSerial: "s1", bibleCid: 1, bibleRid: 1 },
          { name: "Bora", class: "Artist", bibleSerial: "s2", bibleCid: 2, bibleRid: 2 },
          { name: "Ciel", class: "Artist", bibleSerial: "s3", bibleCid: 3, bibleRid: 3 },
        ],
      },
    ],
  };
}

test("auto-manage gather overlaps cached character log fetches through the limiter", async () => {
  const limiter = createTestLimiter(2);
  const service = makeService({ bibleLimiter: limiter });
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ok: true,
      json: async () => [],
    };
  };

  try {
    const collected = await service.gatherAutoManageLogsForUserDoc(
      testRosterWithCachedBibleIds(),
      1000
    );

    assert.equal(fetchCalls, 3);
    assert.equal(limiter.maxActive, 2);
    assert.deepEqual(collected.map((entry) => entry.charName), ["Aki", "Bora", "Ciel"]);
    assert.ok(collected.every((entry) => Array.isArray(entry.logs) && !entry.error));
  } finally {
    global.fetch = originalFetch;
  }
});

test("auto-manage gather caps per-user character fan-out instead of flooding the global queue", async () => {
  const limiter = createTestLimiter(2);
  const service = makeService({ bibleLimiter: limiter });
  const originalFetch = global.fetch;
  const pending = [];
  let gatherPromise = null;

  global.fetch = async () => {
    const deferred = createDeferred();
    pending.push(deferred);
    return deferred.promise;
  };

  try {
    gatherPromise = service.gatherAutoManageLogsForUserDoc(
      testRosterWithCachedBibleIds(),
      1000
    );

    await tick();
    await tick();
    assert.equal(limiter.runCalls, 2);

    pending[0].resolve(emptyBibleResponse());
    await tick();
    await tick();
    assert.equal(limiter.runCalls, 3);

    pending[1].resolve(emptyBibleResponse());
    pending[2].resolve(emptyBibleResponse());
    const collected = await gatherPromise;
    assert.deepEqual(collected.map((entry) => entry.charName), ["Aki", "Bora", "Ciel"]);
  } finally {
    global.fetch = async () => emptyBibleResponse();
    for (const deferred of pending) deferred.resolve(emptyBibleResponse());
    if (gatherPromise) await gatherPromise.catch(() => {});
    global.fetch = originalFetch;
  }
});
