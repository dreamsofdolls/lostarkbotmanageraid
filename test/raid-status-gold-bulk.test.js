"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyGoldReceive,
  applyModeDecision,
  parseGoldModeValues,
  parseGoldReceiveValues,
  saveBulkGoldReceive,
  saveBulkRaidModes,
} = require("../bot/handlers/raid-status/gold/gold-actions");
const User = require("../bot/models/user");
const { getTargetResetKey } = require("../bot/services/raid/schedulers/weekly-reset");

const directSave = async (attempt) => attempt();

// A real Mongoose document so writes go through the strict:false subdoc
// re-cast; save() is stubbed and counted.
function makeRosterModel(characters) {
  const stats = { saves: 0 };
  const doc = new User({
    discordId: "owner",
    weeklyResetKey: getTargetResetKey(),
    accounts: [{ accountName: "Perfectwings", characters }],
  });
  doc.save = async () => {
    stats.saves += 1;
    return doc;
  };
  return { stats, doc, model: { async findOne() { return doc; } } };
}

function charsOf(doc) {
  return doc.toObject().accounts[0].characters;
}

function character(name, itemLevel, assignedRaids = {}) {
  return { name, itemLevel, assignedRaids };
}

const cleared = { difficulty: "Normal", completedDate: 1 };

// ─── parseGoldModeValues ───

test("parseGoldModeValues keeps the highest mode per raid and reports the collapse", () => {
  const parsed = parseGoldModeValues(["belgardin::normal", "belgardin::hard", "armoche::hard"]);
  assert.equal(parsed.invalid, false);
  assert.deepEqual(parsed.decisions.get("belgardin"), { modeKey: "hard" });
  assert.deepEqual(parsed.decisions.get("armoche"), { modeKey: "hard" });
  assert.deepEqual(parsed.collapsed, [
    { raidKey: "belgardin", keptModeKey: "hard", droppedModeKeys: ["normal"] },
  ]);
});

test("parseGoldModeValues lets a mode win over cancel for the same raid", () => {
  const parsed = parseGoldModeValues(["horizon::cancel", "horizon::nightmare"]);
  assert.deepEqual(parsed.decisions.get("horizon"), { modeKey: "nightmare" });
  assert.deepEqual(parsed.collapsed, []);
});

test("parseGoldModeValues keeps a lone cancel", () => {
  const parsed = parseGoldModeValues(["kazeros::cancel"]);
  assert.deepEqual(parsed.decisions.get("kazeros"), { cancel: true });
});

test("parseGoldModeValues rejects the old Name::raid::mode format", () => {
  const parsed = parseGoldModeValues(["Aki::armoche::hard"]);
  assert.equal(parsed.invalid, true);
  assert.equal(parsed.decisions.size, 0);
});

test("parseGoldModeValues rejects an unknown raid or mode", () => {
  assert.equal(parseGoldModeValues(["nope::hard"]).invalid, true);
  assert.equal(parseGoldModeValues(["armoche::nightmare"]).invalid, true);
});

// ─── applyModeDecision ───

test("applyModeDecision: below the mode's iLvl is ineligible and untouched", () => {
  const target = character("Priscilladuk", 1765, { belgardin: { modeKey: "normal" } });
  assert.equal(applyModeDecision(target, "belgardin", { modeKey: "hard" }), "ineligible");
  assert.equal(target.assignedRaids.belgardin.modeKey, "normal");
});

test("applyModeDecision: no clears this week changes the mode immediately", () => {
  const target = character("Soulrano", 1771, { belgardin: { modeKey: "normal" } });
  assert.equal(applyModeDecision(target, "belgardin", { modeKey: "hard" }), "immediate");
  assert.equal(target.assignedRaids.belgardin.modeKey, "hard");
  assert.equal(target.assignedRaids.belgardin.pendingModeKey, undefined);
});

test("applyModeDecision: clears this week defer a new target", () => {
  const target = character("Nailaduk", 1772, { kazeros: { modeKey: "normal", G1: cleared } });
  assert.equal(applyModeDecision(target, "kazeros", { modeKey: "hard" }), "deferred");
  assert.equal(target.assignedRaids.kazeros.modeKey, "normal");
  assert.equal(target.assignedRaids.kazeros.pendingModeKey, "hard");
});

test("applyModeDecision: a pending change already equal to the target is a no-op", () => {
  const target = character("Nailaduk", 1772, {
    kazeros: { modeKey: "normal", pendingModeKey: "hard", G1: cleared },
  });
  assert.equal(applyModeDecision(target, "kazeros", { modeKey: "hard" }), "noop");
  assert.equal(target.assignedRaids.kazeros.pendingModeKey, "hard");
});

test("applyModeDecision: picking the current mode while pending cancels the pending", () => {
  const target = character("Nailaduk", 1772, {
    kazeros: { modeKey: "normal", pendingModeKey: "hard", G1: cleared },
  });
  assert.equal(applyModeDecision(target, "kazeros", { modeKey: "normal" }), "cancelled");
  assert.equal(target.assignedRaids.kazeros.pendingModeKey, undefined);
});

test("applyModeDecision: already on the target with nothing pending is a no-op", () => {
  const target = character("Clauseduk", 1780, { belgardin: { modeKey: "hard" } });
  assert.equal(applyModeDecision(target, "belgardin", { modeKey: "hard" }), "noop");
});

test("applyModeDecision: an explicit cancel clears a pending change, else no-op", () => {
  const pending = character("Nailaduk", 1772, {
    horizon: { modeKey: "hard", pendingModeKey: "nightmare", G1: cleared },
  });
  assert.equal(applyModeDecision(pending, "horizon", { cancel: true }), "cancelled");
  assert.equal(pending.assignedRaids.horizon.pendingModeKey, undefined);

  const idle = character("Soulrano", 1771, { horizon: { modeKey: "nightmare" } });
  assert.equal(applyModeDecision(idle, "horizon", { cancel: true }), "noop");
});

// ─── parseGoldReceiveValues ───

test("parseGoldReceiveValues: auto anywhere wins", () => {
  assert.deepEqual(parseGoldReceiveValues(["armoche", "auto"]), { kind: "auto" });
});

test("parseGoldReceiveValues: up to three known raids form a set", () => {
  assert.deepEqual(parseGoldReceiveValues(["armoche", "kazeros"]), {
    kind: "set",
    raidKeys: ["armoche", "kazeros"],
  });
});

test("parseGoldReceiveValues: four raids or an unknown key is invalid", () => {
  assert.deepEqual(parseGoldReceiveValues(["armoche", "kazeros", "serca", "horizon"]), { kind: "invalid" });
  assert.deepEqual(parseGoldReceiveValues(["nope"]), { kind: "invalid" });
  assert.deepEqual(parseGoldReceiveValues([]), { kind: "invalid" });
});

// ─── applyGoldReceive ───

test("applyGoldReceive set pins ticked raids and excludes the rest", () => {
  const target = character("Soulrano", 1771);
  const result = applyGoldReceive(target, { kind: "set", raidKeys: ["armoche", "kazeros", "serca"] });
  assert.equal(result.changed, true);
  assert.deepEqual(result.before, ["kazeros", "serca", "belgardin"]);
  assert.deepEqual(result.after, ["armoche", "kazeros", "serca"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(target.assignedRaids.armoche.goldOverride, "include");
  assert.equal(target.assignedRaids.horizon.goldOverride, "exclude");
  assert.equal(target.assignedRaids.belgardin.goldOverride, "exclude");
});

test("applyGoldReceive with fewer raids ticked than gold slots lets Artist fill the rest", () => {
  const target = character("Qiylyn", 1772.5);
  const result = applyGoldReceive(target, { kind: "set", raidKeys: ["horizon"] });
  assert.equal(result.changed, true);
  assert.deepEqual(result.before, ["kazeros", "serca", "belgardin"]);
  assert.deepEqual(result.after, ["serca", "horizon", "belgardin"]);
  assert.equal(target.assignedRaids.horizon.goldOverride, "include");
  for (const raidKey of ["armoche", "kazeros", "serca", "belgardin"]) {
    assert.equal(target.assignedRaids[raidKey]?.goldOverride, undefined, raidKey);
  }
});

test("applyGoldReceive with fewer ticks clears earlier hand exclusions so the free slots refill", () => {
  // The state a lone Horizon tick left under the old rule.
  const target = character("Qiylyn", 1772.5, {
    armoche: { goldOverride: "exclude" },
    kazeros: { goldOverride: "exclude" },
    serca: { goldOverride: "exclude" },
    horizon: { modeKey: "nightmare", goldOverride: "include" },
    belgardin: { goldOverride: "exclude" },
  });
  const result = applyGoldReceive(target, { kind: "set", raidKeys: ["horizon", "kazeros"] });
  assert.deepEqual(result.before, ["horizon"]);
  assert.deepEqual(result.after, ["kazeros", "horizon", "belgardin"]);
  assert.equal(target.assignedRaids.serca.goldOverride, undefined);
  assert.equal(target.assignedRaids.belgardin.goldOverride, undefined);
});

test("applyGoldReceive skips a ticked raid the character does not have", () => {
  const target = character("Lowbie", 1745);
  const result = applyGoldReceive(target, { kind: "set", raidKeys: ["armoche", "belgardin"] });
  assert.deepEqual(result.skipped, ["belgardin"]);
  // Armoche is pinned; the slots Belgardin would have taken refill automatically.
  assert.deepEqual(result.after, ["armoche", "kazeros", "serca"]);
  assert.equal(target.assignedRaids.belgardin?.goldOverride, undefined);
});

test("applyGoldReceive leaves a character as is when it has none of the ticked raids", () => {
  // Writing the set would exclude every raid it has and leave it no gold.
  const target = character("Lowbie", 1745, { armoche: { modeKey: "hard" } });
  const result = applyGoldReceive(target, { kind: "set", raidKeys: ["belgardin"] });
  assert.equal(result.changed, false);
  assert.deepEqual(result.skipped, ["belgardin"]);
  assert.deepEqual(result.after, result.before);
  assert.equal(target.assignedRaids.armoche.goldOverride, undefined);
});

test("applyGoldReceive reports no change when overrides already match", () => {
  const target = character("Soulrano", 1771);
  const receive = { kind: "set", raidKeys: ["armoche", "kazeros", "serca"] };
  applyGoldReceive(target, receive);
  const again = applyGoldReceive(target, receive);
  assert.equal(again.changed, false);
});

test("applyGoldReceive auto clears overrides on every assigned raid", () => {
  const target = character("Lowbie", 1745, {
    armoche: { goldOverride: "include" },
    belgardin: { goldOverride: "exclude" },
  });
  const result = applyGoldReceive(target, { kind: "auto" });
  assert.equal(result.changed, true);
  assert.equal(target.assignedRaids.armoche.goldOverride, undefined);
  assert.equal(target.assignedRaids.belgardin.goldOverride, undefined);
});

test("applyGoldReceive auto with nothing overridden is unchanged", () => {
  const target = character("Soulrano", 1771, { armoche: { modeKey: "hard" } });
  assert.equal(applyGoldReceive(target, { kind: "auto" }).changed, false);
});

// ─── multi-character writers ───

function exampleRoster() {
  const kazerosCleared = { modeKey: "normal", G1: { difficulty: "Normal", completedDate: 1 } };
  const belgardinCleared = { modeKey: "normal", G1: { difficulty: "Normal", completedDate: 1 } };
  return makeRosterModel([
    { id: "c1", name: "Soulrano", class: "Destroyer", itemLevel: 1771, assignedRaids: {
      armoche: { modeKey: "normal" }, kazeros: { modeKey: "normal" }, belgardin: { modeKey: "normal" },
    } },
    { id: "c2", name: "Nailaduk", class: "Bard", itemLevel: 1772, assignedRaids: {
      armoche: { modeKey: "normal" }, kazeros: kazerosCleared, belgardin: belgardinCleared,
    } },
    { id: "c3", name: "Priscilladuk", class: "Paladin", itemLevel: 1765, assignedRaids: {
      armoche: { modeKey: "normal" }, kazeros: { modeKey: "normal" }, belgardin: { modeKey: "normal" },
    } },
  ]);
}

const ACT_KAZ_BELG_HARD = parseGoldModeValues(["armoche::hard", "kazeros::hard", "belgardin::hard"]).decisions;

test("saveBulkRaidModes applies every decision to every named character in one save", async () => {
  const { stats, doc, model } = exampleRoster();
  const result = await saveBulkRaidModes({
    User: model,
    saveWithRetry: directSave,
    discordId: "owner",
    targetAccountName: "Perfectwings",
    targetCharNames: ["Soulrano", "Nailaduk", "Priscilladuk"],
    decisions: ACT_KAZ_BELG_HARD,
  });

  assert.equal(stats.saves, 1);
  assert.equal(result.ok, true);
  const outcomes = Object.fromEntries(result.results.map((entry) => [
    entry.name,
    Object.fromEntries(entry.outcomes.map((o) => [o.raidKey, o.outcome])),
  ]));
  assert.deepEqual(outcomes, {
    Soulrano: { armoche: "immediate", kazeros: "immediate", belgardin: "immediate" },
    Nailaduk: { armoche: "immediate", kazeros: "deferred", belgardin: "deferred" },
    Priscilladuk: { armoche: "immediate", kazeros: "immediate", belgardin: "ineligible" },
  });
  const belgardinNeed = result.results[2].outcomes.find((o) => o.raidKey === "belgardin");
  assert.equal(belgardinNeed.minItemLevel, 1770);
  assert.equal(result.results[2].itemLevel, 1765);
  // The summary puts each character's class icon on its line.
  assert.deepEqual(result.results.map((entry) => entry.className), ["Destroyer", "Bard", "Paladin"]);

  const [soul, naila] = charsOf(doc);
  assert.equal(soul.assignedRaids.belgardin.modeKey, "hard");
  assert.equal(naila.assignedRaids.kazeros.pendingModeKey, "hard");
});

test("saveBulkRaidModes names a character missing from the fresh document", async () => {
  const { stats, model } = exampleRoster();
  const result = await saveBulkRaidModes({
    User: model,
    saveWithRetry: directSave,
    discordId: "owner",
    targetAccountName: "Perfectwings",
    targetCharNames: ["Soulrano", "Ghost"],
    decisions: ACT_KAZ_BELG_HARD,
  });
  assert.equal(stats.saves, 1);
  assert.deepEqual(result.results.map((entry) => [entry.name, entry.missing]), [
    ["Soulrano", false],
    ["Ghost", true],
  ]);
});

test("saveBulkRaidModes saves nothing when every decision is a no-op or ineligible", async () => {
  const { stats, model } = exampleRoster();
  const result = await saveBulkRaidModes({
    User: model,
    saveWithRetry: directSave,
    discordId: "owner",
    targetAccountName: "Perfectwings",
    targetCharNames: ["Priscilladuk"],
    decisions: parseGoldModeValues(["belgardin::nightmare", "armoche::normal"]).decisions,
  });
  assert.equal(stats.saves, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results[0].outcomes.map((o) => o.outcome), ["ineligible", "noop"]);
});

test("saveBulkGoldReceive reports changed, pinned and skipped per character", async () => {
  const { stats, doc, model } = makeRosterModel([
    // Auto receives kazeros, serca, belgardin (the three largest unbound totals).
    { id: "c1", name: "AutoMatch", class: "Bard", itemLevel: 1771, assignedRaids: {} },
    { id: "c2", name: "Lowbie", class: "Paladin", itemLevel: 1745, assignedRaids: {} },
  ]);
  const result = await saveBulkGoldReceive({
    User: model,
    saveWithRetry: directSave,
    discordId: "owner",
    targetAccountName: "Perfectwings",
    targetCharNames: ["AutoMatch", "Lowbie"],
    receive: { kind: "set", raidKeys: ["kazeros", "serca", "belgardin"] },
  });

  assert.equal(stats.saves, 1);
  const [match, low] = result.results;
  assert.equal(match.status, "pinned");
  assert.deepEqual(match.kept, ["kazeros", "serca", "belgardin"]);
  // Lowbie has two of the three ticked raids, so its third slot stays
  // automatic and it keeps the raids it already received.
  assert.equal(low.status, "pinned");
  assert.deepEqual(low.skipped, ["belgardin"]);
  assert.deepEqual([match.className, low.className], ["Bard", "Paladin"]);
  assert.equal(charsOf(doc)[0].assignedRaids.armoche.goldOverride, "exclude");
});

test("saveBulkGoldReceive does not save when nothing changes", async () => {
  const { stats, model } = makeRosterModel([
    { id: "c1", name: "AutoOnly", class: "Bard", itemLevel: 1771, assignedRaids: {} },
  ]);
  const result = await saveBulkGoldReceive({
    User: model,
    saveWithRetry: directSave,
    discordId: "owner",
    targetAccountName: "Perfectwings",
    targetCharNames: ["AutoOnly"],
    receive: { kind: "auto" },
  });
  assert.equal(stats.saves, 0);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, "unchanged");
});

// ─── retry ───

// The first loaded document loses a version race on save; the retry loads a
// second one that another write already brought to the target state.
function versionRaceModel(firstCharacter, secondCharacter) {
  const docs = [firstCharacter, secondCharacter].map((characterData) => {
    const { stats, doc } = makeRosterModel([characterData]);
    return { stats, doc };
  });
  docs[0].doc.save = async () => {
    docs[0].stats.saves += 1;
    const error = new Error("concurrent write");
    error.name = "VersionError";
    throw error;
  };
  let loads = 0;
  return { docs, model: { async findOne() { return docs[loads++].doc; } } };
}

test("bulk writers report the outcomes of the attempt that saves, not the one that lost the race", async () => {
  const writers = {
    mode: {
      run: (options) => saveBulkRaidModes({
        ...options,
        decisions: parseGoldModeValues(["armoche::hard"]).decisions,
      }),
      beforeRace: { armoche: { modeKey: "normal" } },
      afterRace: { armoche: { modeKey: "hard" } },
      outcomeOf: (entry) => entry.outcomes[0].outcome,
      expected: "noop",
    },
    gold: {
      run: (options) => saveBulkGoldReceive({ ...options, receive: { kind: "set", raidKeys: ["armoche"] } }),
      beforeRace: {},
      // A lone tick pins that raid and leaves the free slots automatic.
      afterRace: { armoche: { goldOverride: "include" } },
      outcomeOf: (entry) => entry.status,
      expected: "unchanged",
    },
  };
  for (const [label, writer] of Object.entries(writers)) {
    const { docs, model } = versionRaceModel(
      { id: "c1", name: "Aki", class: "Bard", itemLevel: 1720, assignedRaids: writer.beforeRace },
      { id: "c1", name: "Aki", class: "Bard", itemLevel: 1720, assignedRaids: writer.afterRace },
    );
    const result = await writer.run({
      User: model,
      saveWithRetry: User.saveWithRetry,
      discordId: "owner",
      targetAccountName: "Perfectwings",
      targetCharNames: ["Aki"],
    });
    assert.equal(docs[0].stats.saves, 1, label);
    assert.equal(docs[1].stats.saves, 0, label);
    assert.equal(result.ok, false, label);
    assert.equal(writer.outcomeOf(result.results[0]), writer.expected, label);
  }
});
