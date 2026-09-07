"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEditHelpers } = require("../bot/handlers/raid-check/edit/edit-helpers");
const { t } = require("../bot/services/i18n");

const helpers = createEditHelpers({
  normalizeName: (value) => String(value || "").trim().toLowerCase(),
  toModeLabel: (key) => key === "hard" ? "Hard" : "Normal",
  truncateText: (value) => value,
  getGatesForRaid: (key) => key === "act4" ? ["G1", "G2"] : [],
  getGateKeys: (raid) => Object.keys(raid).filter((key) => key.startsWith("G")),
  getRaidScanRange: () => ({ nextMin: Infinity }),
  RAID_REQUIREMENT_MAP: {},
});

test("edit labels keep completed and partial progress ahead of other-mode warnings", () => {
  const cases = [
    { gates: {}, status: "none", suffix: "⚪ 0/2" },
    { gates: { G1: { difficulty: "Normal", completedDate: 1 } }, status: "partial", suffix: "🟠 1/2" },
    { gates: { G1: { difficulty: "Normal", completedDate: 1 }, G2: { difficulty: "Normal", completedDate: 1 } }, status: "complete", suffix: "🟢 2/2" },
    { gates: { G1: { difficulty: "Normal", completedDate: 1 }, G2: { difficulty: "Hard", completedDate: 1 } }, status: "partial", suffix: "🟠 1/2" },
    { gates: { G1: { difficulty: "Hard", completedDate: 1 } }, status: "none", suffix: null },
  ];
  for (const lang of ["vi", "en", "jp"]) {
    for (const { gates, status, suffix } of cases) {
      const char = { charName: "Alice", itemLevel: 1700, assignedRaids: { act4: gates } };
      const gateState = helpers.getCharRaidGateStatus(char, "act4", "normal");
      assert.equal(gateState.overallStatus, status);
      assert.equal(
        helpers.formatCharEditLabel(char, { raidKey: "act4", modeKey: "normal" }, lang),
        `Alice · 1700 · ${suffix || `🟡 ${t("raid-check.editFlow.gateRollupDifferentMode", lang)}`}`,
      );
      const key = status === "complete" ? "Complete" : status === "partial" ? "Partial" : "None";
      assert.ok(helpers.formatGateStateLine(gateState, "act4", lang).includes(
        t(`raid-check.editFlow.gateRollup${key}`, lang),
      ));
    }
  }
});

test("edit labels omit unknown gates and retain the private-log hint", () => {
  const char = { charName: "Alice", itemLevel: 1700, autoManageEnabled: true, publicLogDisabled: true };
  const state = helpers.getCharRaidGateStatus(char, "missing", "normal");
  assert.equal(state.overallStatus, "unknown");
  assert.equal(helpers.formatGateStateLine(state, "missing"), null);
  assert.equal(helpers.formatCharEditLabel(char, { raidKey: "missing" }, "en"),
    `Alice · 1700 · ${t("raid-check.editFlow.charOptionLogOff", "en")}`);
});
