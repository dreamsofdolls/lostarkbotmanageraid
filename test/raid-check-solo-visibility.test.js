"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isRaidCheckVisibleMode,
  isRaidCheckVisibleRaid,
} = require("../bot/handlers/raid-check/visibility");

test("raid-check visibility rejects Solo and gold-locked raids", () => {
  assert.equal(isRaidCheckVisibleMode("solo"), false);
  assert.equal(isRaidCheckVisibleMode("Solo"), false);
  assert.equal(isRaidCheckVisibleMode("normal"), true);
  assert.equal(isRaidCheckVisibleMode("hard"), true);
  assert.equal(isRaidCheckVisibleRaid({ modeKey: "solo" }), false);
  assert.equal(isRaidCheckVisibleRaid({ modeKey: "normal" }), true);
  assert.equal(
    isRaidCheckVisibleRaid({ modeKey: "normal", goldReceives: false }),
    false
  );
  assert.equal(
    isRaidCheckVisibleRaid({ modeKey: "hard", goldReceives: true }),
    true
  );
});
