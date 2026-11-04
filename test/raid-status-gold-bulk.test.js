"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyGoldReceive,
  applyModeDecision,
  parseGoldModeValues,
  parseGoldReceiveValues,
} = require("../bot/handlers/raid-status/gold/gold-actions");

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

test("applyGoldReceive skips a ticked raid the character does not have", () => {
  const target = character("Lowbie", 1745);
  const result = applyGoldReceive(target, { kind: "set", raidKeys: ["armoche", "belgardin"] });
  assert.deepEqual(result.skipped, ["belgardin"]);
  assert.deepEqual(result.after, ["armoche"]);
  assert.equal(target.assignedRaids.belgardin?.goldOverride, undefined);
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
