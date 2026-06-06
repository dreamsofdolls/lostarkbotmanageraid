"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRaidCheckEditApplySummary,
  getRaidCheckEditStatusLabel,
} = require("../bot/handlers/raid-check/edit-ui/summary");

const UI = {
  icons: {
    done: "[done]",
    info: "[info]",
    warn: "[warn]",
  },
};

const targetChar = {
  charName: "Qiylyn",
  itemLevel: 1700,
};

const raidMeta = {
  raidKey: "act4",
  modeKey: "normal",
  minItemLevel: 1700,
};

test("raid-check edit summary resolves status labels without leaking flow logic", () => {
  assert.equal(
    getRaidCheckEditStatusLabel({ statusType: "complete", lang: "en" }),
    "Complete"
  );
  assert.equal(
    getRaidCheckEditStatusLabel({ statusType: "reset", lang: "en" }),
    "Reset"
  );
  assert.equal(
    getRaidCheckEditStatusLabel({
      statusType: "process",
      gate: "G2",
      lang: "en",
    }),
    "Process G2"
  );
  assert.equal(
    getRaidCheckEditStatusLabel({ statusType: "process", lang: "en" }),
    "Process ?"
  );
});

test("raid-check edit summary prioritizes no-roster before success details", () => {
  const summary = buildRaidCheckEditApplySummary({
    result: { noRoster: true, updated: true, modeResetCount: 1 },
    targetChar,
    raidMeta,
    statusType: "complete",
    gate: null,
    dmOutcome: "sent",
    lang: "en",
    UI,
  });

  assert.match(summary.message, /\[warn\] User has no roster\./);
  assert.doesNotMatch(summary.message, /Applied/);
  assert.match(summary.message, /DM sent/);
  assert.match(summary.message, new RegExp(summary.raidLabel));
});

test("raid-check edit summary reports success, mode wipe, and DM failure", () => {
  const summary = buildRaidCheckEditApplySummary({
    result: { updated: true, modeResetCount: 2 },
    targetChar,
    raidMeta,
    statusType: "complete",
    gate: null,
    dmOutcome: "failed",
    lang: "en",
    UI,
  });

  assert.equal(summary.statusLabel, "Complete");
  assert.match(summary.message, /\[done\] Applied \*\*Complete\*\* to \*\*Qiylyn\*\*/);
  assert.match(summary.message, /Old-mode progress was wiped/);
  assert.match(summary.message, /\[warn\] _DM to member failed/);
  assert.match(summary.message, new RegExp(summary.raidLabel));
});

test("raid-check edit summary reports item-level ineligibility", () => {
  const summary = buildRaidCheckEditApplySummary({
    result: { ineligibleItemLevel: 1680 },
    targetChar,
    raidMeta,
    statusType: "process",
    gate: "G1",
    dmOutcome: null,
    lang: "en",
    UI,
  });

  assert.equal(summary.statusLabel, "Process G1");
  assert.match(summary.message, /\[warn\] Char iLvl 1680 does not meet/);
  assert.match(summary.message, /1700\+\)/);
  assert.doesNotMatch(summary.message, /DM/);
});
