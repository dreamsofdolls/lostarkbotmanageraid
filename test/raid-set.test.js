// Tests for /raid-set's core write path: applyRaidSetForDiscordId.
//
// This function is the SINGLE write entry point for raid completion
// state — driven by the slash command, the text-channel monitor parser,
// and the /raid-check Edit flow. Bugs here cascade everywhere, so the
// short-circuit semantics (alreadyComplete / alreadyReset / mode-switch
// wipe) get specific coverage.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder, MessageFlags } = require("discord.js");

const { createRaidSetCommand } = require("../bot/handlers/raid-set");
const {
  UI,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  toModeLabel,
} = require("../bot/utils/raid/shared");
const {
  createCharacterId,
  ensureAssignedRaids,
  normalizeAssignedRaid,
  getGateKeys,
  RAID_REQUIREMENT_MAP,
} = require("../bot/utils/raid/character");
const {
  getRaidRequirementList,
  getGatesForRaid,
} = require("../bot/models/Raid");

function makeUserModel() {
  const docs = new Map();
  class User {
    constructor(data = {}) {
      this.discordId = data.discordId || null;
      this.accounts = JSON.parse(JSON.stringify(data.accounts || []));
    }
    async save() {
      docs.set(this.discordId, {
        discordId: this.discordId,
        accounts: JSON.parse(JSON.stringify(this.accounts)),
      });
      return this;
    }
    static findOne(query) {
      const data = docs.get(query.discordId);
      return {
        async lean() {
          return data ? JSON.parse(JSON.stringify(data)) : null;
        },
        then(resolve, reject) {
          const result = data ? new User(JSON.parse(JSON.stringify(data))) : null;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
    }
  }
  return { User, docs };
}

function makeFactory(overrides = {}) {
  const { User, docs } = makeUserModel();
  // Default loaders read from the same in-memory `docs` map seeded by
  // tests via seedUser, so resolveRosterOwner-style tests don't need
  // to wire bespoke mocks for every assertion.
  const defaultLoadUserForAutocomplete = async (discordId) => {
    const data = docs.get(discordId);
    return data ? JSON.parse(JSON.stringify(data)) : null;
  };
  const defaultLoadAccountsRegisteredBy = async (discordId) => {
    const out = [];
    for (const data of docs.values()) {
      if (!Array.isArray(data.accounts)) continue;
      const matched = data.accounts.some((a) => a.registeredBy === discordId);
      if (matched) out.push(JSON.parse(JSON.stringify(data)));
    }
    return out;
  };
  const factory = createRaidSetCommand({
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    saveWithRetry: async (op) => op(),
    ensureFreshWeek: () => false,
    normalizeName,
    getCharacterName,
    getCharacterClass,
    createCharacterId,
    loadUserForAutocomplete:
      overrides.loadUserForAutocomplete || defaultLoadUserForAutocomplete,
    loadAccountsRegisteredBy:
      overrides.loadAccountsRegisteredBy || defaultLoadAccountsRegisteredBy,
    getRaidRequirementList,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    ensureAssignedRaids,
    normalizeAssignedRaid,
    getGateKeys,
    toModeLabel,
  });
  return { factory, User, docs };
}

function makeChar(name, itemLevel, assignedRaids = {}) {
  return {
    id: `${name}-id`,
    name,
    class: "Bard",
    itemLevel,
    assignedRaids,
    tasks: [],
  };
}

function seedUser(docs, accounts) {
  docs.set("user-1", {
    discordId: "user-1",
    accounts: JSON.parse(JSON.stringify(accounts)),
  });
}

const KAZEROS_HARD = RAID_REQUIREMENT_MAP.kazeros_hard;
const KAZEROS_NORMAL = RAID_REQUIREMENT_MAP.kazeros_normal;

test("applyRaidSetForDiscordId: complete on fresh raid marks all gates done", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.matched, true);
  assert.equal(result.updated, true);
  assert.equal(result.alreadyComplete, false);
  assert.equal(result.modeResetCount, 0);
  assert.equal(result.displayName, "Cyrano");

  const stored = docs.get("user-1");
  const kaz = stored.accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(kaz.G1.difficulty, "Hard");
  assert.equal(kaz.G2.difficulty, "Hard");
  assert.ok(Number(kaz.G1.completedDate) > 0);
  assert.ok(Number(kaz.G2.completedDate) > 0);
});

test("applyRaidSetForDiscordId: complete short-circuits to alreadyComplete on no-op re-stamp", async () => {
  // Codex-flagged regression class: re-stamping completedDate would
  // surface a fresh "Raid Completed" DM even though nothing changed.
  // Short-circuit must fire when every target gate already has
  // completedDate>0 at the selected difficulty AND no mode switch in
  // play.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    {
      accountName: "Alpha",
      characters: [
        makeChar("Cyrano", 1730, {
          kazeros: {
            G1: { difficulty: "Hard", completedDate: 111 },
            G2: { difficulty: "Hard", completedDate: 222 },
          },
        }),
      ],
    },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.alreadyComplete, true);
  assert.equal(result.updated, false);

  // Original timestamps must NOT have been re-stamped.
  const stored = docs.get("user-1");
  const kaz = stored.accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(kaz.G1.completedDate, 111);
  assert.equal(kaz.G2.completedDate, 222);
});

test("applyRaidSetForDiscordId: process gate marks only that gate done", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "process",
    effectiveGates: ["G1"],
  });

  assert.equal(result.updated, true);
  const kaz = docs.get("user-1").accounts[0].characters[0].assignedRaids.kazeros;
  assert.ok(Number(kaz.G1.completedDate) > 0, "G1 should be stamped");
  assert.ok(!(Number(kaz.G2.completedDate) > 0), "G2 should remain unstamped");
});

test("applyRaidSetForDiscordId: reset on completed raid clears every gate", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    {
      accountName: "Alpha",
      characters: [
        makeChar("Cyrano", 1730, {
          kazeros: {
            G1: { difficulty: "Hard", completedDate: 111 },
            G2: { difficulty: "Hard", completedDate: 222 },
          },
        }),
      ],
    },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "reset",
    effectiveGates: [],
  });

  assert.equal(result.updated, true);
  assert.equal(result.alreadyReset, false);
  const kaz = docs.get("user-1").accounts[0].characters[0].assignedRaids.kazeros;
  assert.equal(kaz.G1.completedDate, null);
  assert.equal(kaz.G2.completedDate, null);
});

test("applyRaidSetForDiscordId: reset on already-empty raid short-circuits to alreadyReset", async () => {
  // Codex-flagged: without the alreadyReset short-circuit, the Edit DM
  // would tell the user "Artist vừa Reset về 0" for a raid they never
  // touched.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] }, // empty assignedRaids
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "reset",
    effectiveGates: [],
  });

  assert.equal(result.alreadyReset, true);
  assert.equal(result.updated, false);
});

test("applyRaidSetForDiscordId: mode-switch wipes existing different-mode gates and stamps modeResetCount", async () => {
  // Char cleared Kazeros Normal earlier in the week; now /raid-set
  // marks Kazeros Hard. The Normal stamps must be wiped before the
  // Hard write so the char doesn't end up with mixed-mode records
  // (which break the gate-status rollup logic).
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    {
      accountName: "Alpha",
      characters: [
        makeChar("Cyrano", 1730, {
          kazeros: {
            G1: { difficulty: "Normal", completedDate: 111 },
            G2: { difficulty: "Normal", completedDate: 222 },
          },
        }),
      ],
    },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.updated, true);
  assert.equal(result.modeResetCount, 1);
  const kaz = docs.get("user-1").accounts[0].characters[0].assignedRaids.kazeros;
  // Mode switched + new mode marked done in the same call.
  assert.equal(kaz.G1.difficulty, "Hard");
  assert.equal(kaz.G2.difficulty, "Hard");
  assert.ok(Number(kaz.G1.completedDate) > 0);
  assert.ok(Number(kaz.G2.completedDate) > 0);
});

test("applyRaidSetForDiscordId: noRoster when user has no accounts", async () => {
  const { factory } = makeFactory();
  // No user doc seeded.

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.noRoster, true);
  assert.equal(result.matched, false);
  assert.equal(result.updated, false);
});

test("applyRaidSetForDiscordId: char not found returns matched=false without touching state", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Bardella", // not in roster
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.matched, false);
  assert.equal(result.updated, false);
  assert.equal(result.noRoster, false);
});

test("applyRaidSetForDiscordId: ineligible itemLevel surfaces ineligibleItemLevel and skips write", async () => {
  // Char at iLvl 1720 trying Kazeros Hard (min 1730) — must reject
  // without writing.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("LowGear", 1720)] },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "LowGear",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.matched, true);
  assert.equal(result.updated, false);
  assert.equal(result.ineligibleItemLevel, 1720);
});

test("applyRaidSetForDiscordId: rosterName scopes lookup so same-named chars across rosters don't collide", async () => {
  // User has TWO accounts both with a char named "Cyrano". Without
  // roster scoping, the first-by-iteration match would always hit
  // account[0]'s char regardless of which roster the user picked.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1700)] }, // ineligible for Hard
    { accountName: "Bravo", characters: [makeChar("Cyrano", 1740)] }, // eligible for Hard
  ]);

  // Target the Bravo Cyrano explicitly via rosterName.
  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Bravo",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.matched, true);
  assert.equal(result.updated, true);
  // Bravo's Cyrano got the stamp; Alpha's stayed clean.
  const stored = docs.get("user-1");
  const alphaCyrano = stored.accounts[0].characters[0];
  const bravoCyrano = stored.accounts[1].characters[0];
  assert.ok(!(Number(alphaCyrano.assignedRaids?.kazeros?.G1?.completedDate) > 0));
  assert.ok(Number(bravoCyrano.assignedRaids.kazeros.G1.completedDate) > 0);
});

test("applyRaidSetForDiscordId: null rosterName falls back to first-by-iteration (text-monitor path)", async () => {
  // Text-channel parser only has the char name (no roster context). This
  // path must still resolve to a character — first match wins.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1740)] },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: null, // text-monitor path
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.matched, true);
  assert.equal(result.updated, true);
});

test("applyRaidSetForDiscordId: characterName matching is case-insensitive (text-monitor lowercases)", async () => {
  // Text-channel monitor parser lowercases char names for alias matching;
  // applyRaidSetForDiscordId must still find the char even when the
  // input case mismatches the saved case. The displayName field returns
  // the saved case so the embed reads correctly.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1740)] },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "cyrano", // lowercased
    rosterName: null,
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.matched, true);
  assert.equal(result.displayName, "Cyrano", "should return saved-case display name");
});

test("applyRaidSetForDiscordId: complete cumulative — process G2 marks G1 too via mark-target list", async () => {
  // Lost Ark sequential progression: process G2 means G1 was cleared
  // first. The /raid-set command and text monitor pre-compute the
  // effectiveGates list as G1..G_N for cumulative semantics. Test that
  // applyRaidSetForDiscordId honors whatever gate list it gets — the
  // cumulative expansion is the caller's responsibility.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: "user-1",
    characterName: "Cyrano",
    rosterName: "Alpha",
    raidMeta: KAZEROS_HARD,
    statusType: "process",
    effectiveGates: ["G1", "G2"], // caller passes cumulative list
  });

  assert.equal(result.updated, true);
  const kaz = docs.get("user-1").accounts[0].characters[0].assignedRaids.kazeros;
  assert.ok(Number(kaz.G1.completedDate) > 0);
  assert.ok(Number(kaz.G2.completedDate) > 0);
});

// ---------------------------------------------------------------------------
// normalizeAssignedRaid: auto-upgrade to best-eligible mode when iLvl bumps
// ---------------------------------------------------------------------------

test("normalizeAssignedRaid: auto-upgrades stale Normal stamp to Hard when iLvl now qualifies", () => {
  // Bug surfaced by Traine: char crossed the 1720 Act 4 Hard threshold
  // but Act 4 still rendered as Normal. Cause: a previous /raid-add-roster
  // (or /raid-edit-roster Confirm) at sub-threshold iLvl stamped
  // assignedRaids.armoche.G1.difficulty="Normal", and bible refresh's
  // iLvl bump never recomputed assignedRaids. normalizeAssignedRaid
  // had been preferring the stored G1.difficulty over the
  // best-eligible fallback for the no-completion case, which made the
  // upgrade impossible without manual /raid-set intervention. Pin the
  // fix: with no completion stamped and stored mode below the best
  // eligible mode, the canonical difficulty should auto-bump up to
  // match the current iLvl tier.
  const stale = {
    G1: { difficulty: "Normal", completedDate: undefined },
    G2: { difficulty: "Normal", completedDate: undefined },
  };
  // armoche Hard threshold = 1720 in RAID_REQUIREMENT_MAP. Pass "Hard"
  // as the fallback (== best-eligible at this iLvl) and confirm both
  // gates flip to Hard.
  const result = normalizeAssignedRaid(stale, "Hard", "armoche");
  assert.equal(result.G1.difficulty, "Hard");
  assert.equal(result.G2.difficulty, "Hard");
});

test("normalizeAssignedRaid: preserves over-tier stamped difficulty (no auto-downgrade)", () => {
  // Inverse of the auto-upgrade case: an over-tier stored difficulty
  // (e.g. Hard manually stamped via /raid-set on a 1700 char that
  // wouldn't actually clear it in-game) may be a deliberate user
  // choice. Auto-downgrading it on every read would silently overwrite
  // intent. Only auto-promote, never auto-demote.
  const stale = {
    G1: { difficulty: "Hard", completedDate: undefined },
    G2: { difficulty: "Hard", completedDate: undefined },
  };
  const result = normalizeAssignedRaid(stale, "Normal", "armoche");
  assert.equal(result.G1.difficulty, "Hard");
  assert.equal(result.G2.difficulty, "Hard");
});

test("normalizeAssignedRaid: in-progress completion locks mode against auto-upgrade", () => {
  // If the player has actually cleared a gate at the lower mode this
  // week, weekly lockout makes the cleared mode the only option until
  // reset. Auto-upgrading would silently invalidate the completion
  // (Lost Ark weekly entries are mode-scoped). The diffTally branch
  // already handled this case, but the regression test pins the
  // contract so refactors can't accidentally drop it.
  const partiallyCleared = {
    G1: { difficulty: "Normal", completedDate: 1700000000000 }, // done
    G2: { difficulty: "Normal", completedDate: undefined },
  };
  const result = normalizeAssignedRaid(partiallyCleared, "Hard", "armoche");
  assert.equal(result.G1.difficulty, "Normal", "completed Normal mode wins over Hard fallback");
  assert.equal(result.G2.difficulty, "Normal", "G2 inherits the canonical mode for coherence");
  assert.ok(Number(result.G1.completedDate) > 0, "G1 completion preserved");
});

// ---------------------------------------------------------------------------
// resolveRosterOwner: helper-Manager routing for /raid-set
// ---------------------------------------------------------------------------
//
// Manager M runs `/raid-add-roster target:U` -> account stamped with
// `registeredBy = M`. Later when M runs `/raid-set`, the resolver lets M
// edit U's progress without re-checking live Manager role. These tests
// pin the four branches (own match, helper match, miss, ambiguous) so a
// future refactor of the lookup order or label preference can't silently
// change semantics.

function seedUserAccounts(docs, discordId, accounts, identityFields = {}) {
  docs.set(discordId, {
    discordId,
    discordUsername: identityFields.discordUsername || "",
    discordGlobalName: identityFields.discordGlobalName || "",
    discordDisplayName: identityFields.discordDisplayName || "",
    accounts: JSON.parse(JSON.stringify(accounts)),
  });
}

test("resolveRosterOwner: own-roster match returns executor as owner with actingForOther=false", async () => {
  const { factory, docs } = makeFactory();
  seedUserAccounts(docs, "manager-1", [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] },
  ]);
  const resolved = await factory.resolveRosterOwner("manager-1", "Alpha");
  assert.equal(resolved.ownerDiscordId, "manager-1");
  assert.equal(resolved.actingForOther, false);
  assert.equal(resolved.account.accountName, "Alpha");
  assert.equal(resolved.ambiguous, undefined);
});

test("resolveRosterOwner: helper-added roster routes the manager to the registered user's doc", async () => {
  const { factory, docs } = makeFactory();
  // Manager-1 has no own roster but registered Bravo for User-2.
  seedUserAccounts(docs, "manager-1", []);
  seedUserAccounts(
    docs,
    "user-2",
    [
      {
        accountName: "Bravo",
        characters: [makeChar("Senko", 1740)],
        registeredBy: "manager-1",
      },
    ],
    { discordDisplayName: "Senko-chan" }
  );
  const resolved = await factory.resolveRosterOwner("manager-1", "Bravo");
  assert.equal(resolved.ownerDiscordId, "user-2");
  assert.equal(resolved.actingForOther, true);
  assert.equal(resolved.ownerLabel, "Senko-chan");
  assert.equal(resolved.account.accountName, "Bravo");
});

test("resolveRosterOwner: own match wins when same accountName exists in both own + helper-added", async () => {
  // Defensive ordering: if a Manager somehow has an account with the same
  // name as one they registered for someone else (rare across-region
  // edge case), the executor's own roster takes precedence so they
  // can't accidentally write to the wrong user.
  const { factory, docs } = makeFactory();
  seedUserAccounts(docs, "manager-1", [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] },
  ]);
  seedUserAccounts(docs, "user-2", [
    {
      accountName: "Alpha",
      characters: [makeChar("Senko", 1740)],
      registeredBy: "manager-1",
    },
  ]);
  const resolved = await factory.resolveRosterOwner("manager-1", "Alpha");
  assert.equal(resolved.ownerDiscordId, "manager-1");
  assert.equal(resolved.actingForOther, false);
});

test("resolveRosterOwner: roster not found in own or helper-added returns null", async () => {
  const { factory, docs } = makeFactory();
  seedUserAccounts(docs, "manager-1", [
    { accountName: "Alpha", characters: [makeChar("Cyrano", 1730)] },
  ]);
  const resolved = await factory.resolveRosterOwner("manager-1", "NonExistent");
  assert.equal(resolved, null);
});

test("resolveRosterOwner: same accountName registered for two different users returns ambiguous", async () => {
  // Pathological cross-region case: char names should be unique within a
  // region, but if a Manager registered "Belmont" for U1 (NA) and another
  // "Belmont" for U2 (different region or LA name reuse after deletion),
  // the resolver must NOT silently pick one - surface ambiguity so the
  // command reply can tell the executor to clean up.
  const { factory, docs } = makeFactory();
  seedUserAccounts(docs, "manager-1", []);
  seedUserAccounts(
    docs,
    "user-2",
    [
      {
        accountName: "Belmont",
        characters: [makeChar("Belmont", 1740)],
        registeredBy: "manager-1",
      },
    ],
    { discordDisplayName: "User Two" }
  );
  seedUserAccounts(
    docs,
    "user-3",
    [
      {
        accountName: "Belmont",
        characters: [makeChar("Belmont", 1730)],
        registeredBy: "manager-1",
      },
    ],
    { discordDisplayName: "User Three" }
  );
  const resolved = await factory.resolveRosterOwner("manager-1", "Belmont");
  assert.equal(resolved.ambiguous, true);
  assert.equal(resolved.matches.length, 2);
  const ownerIds = resolved.matches.map((m) => m.ownerDiscordId).sort();
  assert.deepEqual(ownerIds, ["user-2", "user-3"]);
});

test("resolveRosterOwner: empty rosterName returns null without DB calls", async () => {
  let loadCalled = false;
  const { factory } = makeFactory({
    loadUserForAutocomplete: async () => {
      loadCalled = true;
      return null;
    },
  });
  const resolved = await factory.resolveRosterOwner("manager-1", "");
  assert.equal(resolved, null);
  assert.equal(loadCalled, false, "should short-circuit before any DB read");
});

test("applyRaidSetForDiscordId via helper-Manager flow: write lands on registered user, not executor", async () => {
  // End-to-end sanity check that the resolver + write path agree: even
  // if Manager M is the executor, the actual save target is User U's
  // doc (the owner of the helper-added account). M's doc must stay
  // untouched.
  const { factory, docs } = makeFactory();
  seedUserAccounts(docs, "manager-1", [
    { accountName: "Manager-Own", characters: [makeChar("MgrChar", 1730)] },
  ]);
  seedUserAccounts(docs, "user-2", [
    {
      accountName: "TargetRoster",
      characters: [makeChar("Senko", 1740)],
      registeredBy: "manager-1",
    },
  ]);

  // Manager-1 picks "TargetRoster" -> resolves to user-2 -> write lands
  // on user-2.
  const resolved = await factory.resolveRosterOwner(
    "manager-1",
    "TargetRoster"
  );
  assert.equal(resolved.actingForOther, true);
  const result = await factory.applyRaidSetForDiscordId({
    discordId: resolved.ownerDiscordId,
    executorId: "manager-1",
    characterName: "Senko",
    rosterName: "TargetRoster",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });
  assert.equal(result.matched, true);
  assert.equal(result.updated, true);

  // Target's roster got the stamp; manager's own roster is untouched.
  const target = docs.get("user-2");
  const targetKaz = target.accounts[0].characters[0].assignedRaids.kazeros;
  assert.ok(Number(targetKaz.G1.completedDate) > 0);
  assert.ok(Number(targetKaz.G2.completedDate) > 0);

  const manager = docs.get("manager-1");
  const mgrChar = manager.accounts[0].characters[0];
  assert.ok(
    !mgrChar.assignedRaids ||
      !Number(mgrChar.assignedRaids?.kazeros?.G1?.completedDate),
    "manager's own roster must remain unchanged"
  );
});

test("applyRaidSetForDiscordId via helper-Manager flow: re-checks registeredBy before writing", async () => {
  // Resolve happens before the save retry closure. If the target roster is
  // removed/re-added or its helper ownership changes in between, the write
  // path must re-check registeredBy on the fresh doc and refuse to stamp.
  const { factory, docs } = makeFactory();
  seedUserAccounts(docs, "manager-1", []);
  seedUserAccounts(docs, "user-2", [
    {
      accountName: "TargetRoster",
      characters: [makeChar("Senko", 1740)],
      registeredBy: "manager-1",
    },
  ]);

  const resolved = await factory.resolveRosterOwner(
    "manager-1",
    "TargetRoster"
  );
  assert.equal(resolved.actingForOther, true);

  // Simulate a race after resolveRosterOwner: same owner doc and same roster
  // name still exist, but this account is no longer authorized for manager-1.
  seedUserAccounts(docs, "user-2", [
    {
      accountName: "TargetRoster",
      characters: [makeChar("Senko", 1740)],
      registeredBy: "other-manager",
    },
  ]);

  const result = await factory.applyRaidSetForDiscordId({
    discordId: resolved.ownerDiscordId,
    executorId: "manager-1",
    characterName: "Senko",
    rosterName: "TargetRoster",
    raidMeta: KAZEROS_HARD,
    statusType: "complete",
    effectiveGates: [],
  });

  assert.equal(result.authLost, true);
  assert.equal(result.updated, false);
  assert.equal(result.matched, false);

  const target = docs.get("user-2");
  const targetKaz = target.accounts[0].characters[0].assignedRaids?.kazeros;
  assert.ok(
    !Number(targetKaz?.G1?.completedDate),
    "stale helper authorization must not stamp the target roster"
  );
});

// ---------------------------------------------------------------------------
// normalizeAssignedRaid: auto-upgrade to best-eligible mode when iLvl bumps
// ---------------------------------------------------------------------------

test("normalizeAssignedRaid: empty stored difficulty falls back to best-eligible", () => {
  // Fresh char path: assignedRaid is `{}` (or missing G1/G2 difficulty
  // strings). With nothing to preserve, the best-eligible fallback is
  // the natural choice.
  const result = normalizeAssignedRaid({}, "Hard", "armoche");
  assert.equal(result.G1.difficulty, "Hard");
  assert.equal(result.G2.difficulty, "Hard");
});
