const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRaidChannelActionChoices,
  isRaidChannelActionVisible,
} = require("../bot/handlers/raid/channel/action-options");
const { normalizeName } = require("../bot/utils/raid/common/shared");

function translate(key) {
  return `label:${key}`;
}

test("raid-channel action options hide redundant schedule toggles", () => {
  assert.equal(isRaidChannelActionVisible({ value: "schedule-on" }, true), false);
  assert.equal(isRaidChannelActionVisible({ value: "schedule-off" }, true), true);
  assert.equal(isRaidChannelActionVisible({ value: "schedule-on" }, false), true);
  assert.equal(isRaidChannelActionVisible({ value: "schedule-off" }, false), false);
});

test("raid-channel action options localize labels and filter by needle", () => {
  const choices = buildRaidChannelActionChoices({
    lang: "en",
    needle: "language",
    autoCleanupEnabled: false,
    t: translate,
    normalizeName,
  });

  assert.deepEqual(choices, [{
    name: "label:raid-channel-language.autocompleteLabel",
    value: "set-language",
  }]);
});

test("raid-channel action options cap autocomplete output to Discord limit", () => {
  const choices = Array.from({ length: 30 }, (_, i) => ({
    value: `action-${i}`,
    labelKey: `action${i}`,
  }));
  const result = buildRaidChannelActionChoices({
    lang: "en",
    choices,
    t: translate,
    normalizeName,
  });

  assert.equal(result.length, 25);
});
