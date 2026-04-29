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

const { createRaidSetCommand } = require("../src/commands/raid-set");
const {
  UI,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  toModeLabel,
} = require("../src/raid/shared");
const {
  createCharacterId,
  ensureAssignedRaids,
  normalizeAssignedRaid,
  getGateKeys,
  RAID_REQUIREMENT_MAP,
} = require("../src/raid/character");
const {
  getRaidRequirementList,
  getGatesForRaid,
} = require("../src/data/Raid");

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

function makeFactory() {
  const { User, docs } = makeUserModel();
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
    loadUserForAutocomplete: async () => null,
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
  // but Act 4 still rendered as Normal. Cause: a previous /add-roster
  // (or /edit-roster Confirm) at sub-threshold iLvl stamped
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

test("normalizeAssignedRaid: empty stored difficulty falls back to best-eligible", () => {
  // Fresh char path: assignedRaid is `{}` (or missing G1/G2 difficulty
  // strings). With nothing to preserve, the best-eligible fallback is
  // the natural choice.
  const result = normalizeAssignedRaid({}, "Hard", "armoche");
  assert.equal(result.G1.difficulty, "Hard");
  assert.equal(result.G2.difficulty, "Hard");
});
