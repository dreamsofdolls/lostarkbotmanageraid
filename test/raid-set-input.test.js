"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getRaidRequirementMap, getGatesForRaid } = require("../bot/domain/raid-catalog");
const { getRaidModeLabel } = require("../bot/utils/raid/common/labels");
const { createRaidSetInputHelpers } = require("../bot/handlers/raid/set/command-input");

const { validateRaidSetInput } = createRaidSetInputHelpers({
  RAID_REQUIREMENT_MAP: getRaidRequirementMap(),
  getGatesForRaid,
  getRaidModeLabel,
  t: (key) => key,
});

for (const raidKey of ["constructor", "toString", "__proto__"]) {
  test(`raid-set refuses the typed raid "${raidKey}"`, () => {
    const result = validateRaidSetInput({ raidKey, statusType: "complete", targetGate: "" }, "en");
    assert.equal(result.valid, false);
    assert.equal(result.notice.title, "raid-set.invalid.raidTitle");
  });
}
