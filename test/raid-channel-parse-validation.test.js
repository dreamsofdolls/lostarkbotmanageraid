"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveParsedRaidUpdate,
} = require("../bot/services/raid/channel-monitor/channel-monitor-parse-validation");

const UI = { icons: { warn: "[warn]" } };
const RAID_REQUIREMENT_MAP = {
  act4_normal: {
    raidKey: "act4",
    modeKey: "normal",
    label: "Act 4 Normal",
  },
  act4_solo: {
    raidKey: "act4",
    modeKey: "solo",
    label: "Act 4 Solo",
  },
};
const getGatesForRaid = () => ["G1", "G2", "G3"];

function fakeT(key, lang, vars = {}) {
  return `${key}|${lang}|${JSON.stringify(vars)}`;
}

test("raid-channel parse validation renders parser error hints", () => {
  const resolved = resolveParsedRaidUpdate({
    parsed: { error: "multi-gate", gates: ["G1", "G2"] },
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    UI,
    lang: "en",
    t: fakeT,
  });

  assert.equal(resolved.action, "hint");
  assert.match(resolved.content, /^text-parser\.multiGate\|en\|/);
  assert.match(resolved.content, /"gates":"G1, G2"/);
});

test("raid-channel parse validation expands a posted gate cumulatively", () => {
  const resolved = resolveParsedRaidUpdate({
    parsed: {
      raidKey: "act4",
      modeKey: "normal",
      charNames: ["Qiylyn"],
      gate: "G2",
    },
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    UI,
    lang: "en",
    t: fakeT,
  });

  assert.equal(resolved.action, "update");
  assert.equal(resolved.statusType, "process");
  assert.deepEqual(resolved.charNames, ["Qiylyn"]);
  assert.deepEqual(resolved.effectiveGates, ["G1", "G2"]);
});

test("raid-channel parse validation accepts supported Solo raids", () => {
  const resolved = resolveParsedRaidUpdate({
    parsed: {
      raidKey: "act4",
      modeKey: "solo",
      charNames: ["Qiylyn"],
      gate: "G2",
    },
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    UI,
    lang: "en",
    t: fakeT,
  });

  assert.equal(resolved.action, "update");
  assert.equal(resolved.raidMeta.modeKey, "solo");
  assert.equal(resolved.statusType, "process");
  assert.deepEqual(resolved.effectiveGates, ["G1", "G2"]);
});

test("raid-channel parse validation rejects Solo for Horizon", () => {
  const resolved = resolveParsedRaidUpdate({
    parsed: {
      raidKey: "horizon",
      modeKey: "solo",
      charNames: ["Qiylyn"],
      gate: null,
    },
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    UI,
    lang: "en",
    t: fakeT,
  });

  assert.equal(resolved.action, "hint");
  assert.match(resolved.content, /^text-parser\.invalidCombo\|en\|/);
  assert.match(resolved.content, /"modeKey":"solo"/);
});

test("raid-channel parse validation rejects gates outside the raid catalog", () => {
  const resolved = resolveParsedRaidUpdate({
    parsed: {
      raidKey: "act4",
      modeKey: "normal",
      charNames: ["Qiylyn"],
      gate: "G4",
    },
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    UI,
    lang: "vi",
    t: fakeT,
  });

  assert.equal(resolved.action, "hint");
  assert.match(resolved.content, /^text-parser\.invalidGate\|vi\|/);
  assert.match(resolved.content, /"`G1`, `G2`, `G3`"/);
});

test("raid-channel parse validation resolves raid-level reset without changing mode", () => {
  const resolved = resolveParsedRaidUpdate({
    parsed: {
      raidKey: "act4",
      modeKey: null,
      action: "reset",
      charNames: ["Qiylyn"],
      gate: null,
    },
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    getRaidLabel: () => "Act 4",
    UI,
    lang: "en",
    t: fakeT,
  });

  assert.equal(resolved.action, "update");
  assert.equal(resolved.statusType, "reset");
  assert.deepEqual(resolved.effectiveGates, []);
  assert.equal(resolved.raidMeta.raidKey, "act4");
  assert.equal(resolved.raidMeta.label, "Act 4");
  assert.equal(resolved.raidMeta.minItemLevel, 0);
});

test("raid-channel parse validation renders reset syntax hints", () => {
  for (const error of ["reset-with-difficulty", "reset-with-gate"]) {
    const resolved = resolveParsedRaidUpdate({
      parsed: { error },
      RAID_REQUIREMENT_MAP,
      getGatesForRaid,
      UI,
      lang: "vi",
      t: fakeT,
    });

    assert.equal(resolved.action, "hint");
    assert.match(resolved.content, new RegExp(`^text-parser\\.${error === "reset-with-gate" ? "resetWithGate" : "resetWithDifficulty"}\\|vi\\|`));
  }
});
