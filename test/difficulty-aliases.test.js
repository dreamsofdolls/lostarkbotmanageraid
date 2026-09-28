process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CORE_MODE_ALIASES,
  SHORTHAND_MODE_ALIASES,
  buildModeAliasMap,
} = require("../bot/domain/difficulty-aliases");
const { normalizeDifficulty } = require("../bot/services/local-sync/core/catalog");
const { normalizeDifficultyToModeKey } = require("../bot/services/auto-manage/bible/log-utils");
const { toModeKey } = require("../bot/utils/raid/common/shared");
const { parseRaidMessage } = require("../bot/services/raid/channel-monitor/channel-monitor-parser");

test("every difficulty reader resolves the core aliases the same way", () => {
  for (const [modeKey, aliases] of Object.entries(CORE_MODE_ALIASES)) {
    for (const alias of aliases) {
      assert.equal(normalizeDifficulty(alias), modeKey, `catalog: ${alias}`);
      assert.equal(normalizeDifficultyToModeKey(alias), modeKey, `bible: ${alias}`);
      assert.equal(toModeKey(alias), modeKey, `toModeKey: ${alias}`);
      // Channel tokens never hold a space; "level 1" is folded to "level1" first.
      const parsed = parseRaidMessage(`kazeros ${alias} aki`);
      assert.equal(parsed?.modeKey, modeKey, `parser: ${alias}`);
    }
  }
});

test("VN shorthand reaches Bible, stored labels and the raid channel, not LOA Logs", () => {
  for (const [modeKey, aliases] of Object.entries(SHORTHAND_MODE_ALIASES)) {
    for (const alias of aliases) {
      assert.equal(normalizeDifficultyToModeKey(alias), modeKey, `bible: ${alias}`);
      assert.equal(toModeKey(alias), modeKey, `toModeKey: ${alias}`);
      assert.equal(parseRaidMessage(`kazeros ${alias} aki`)?.modeKey, modeKey, `parser: ${alias}`);
      assert.equal(normalizeDifficulty(alias), null, `catalog: ${alias}`);
    }
  }
});

test("buildModeAliasMap rejects an alias sent to two modes", () => {
  assert.throws(
    () => buildModeAliasMap({ normal: ["nm"] }, { nightmare: ["nm"] }),
    /"nm" maps to both normal and nightmare/
  );
  assert.equal(buildModeAliasMap({ hard: ["hm"] }, { hard: ["hm"] }).get("hm"), "hard");
});
