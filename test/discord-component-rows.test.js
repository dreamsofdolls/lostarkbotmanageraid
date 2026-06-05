const test = require("node:test");
const assert = require("node:assert/strict");

const {
  disableComponentRows,
} = require("../bot/utils/discord/component-rows");

test("discord component rows helper disables every disable-capable component", () => {
  const calls = [];
  const rows = [
    {
      components: [
        { setDisabled(value) { calls.push(["a", value]); return this; } },
        { setDisabled(value) { calls.push(["b", value]); return this; } },
      ],
    },
    {
      components: [
        { label: "static" },
        { setDisabled(value) { calls.push(["c", value]); return this; } },
      ],
    },
  ];

  assert.equal(disableComponentRows(rows), rows);
  assert.deepEqual(calls, [
    ["a", true],
    ["b", true],
    ["c", true],
  ]);
});

test("discord component rows helper tolerates empty or malformed rows", () => {
  assert.equal(disableComponentRows(null), null);
  assert.doesNotThrow(() => disableComponentRows([null, {}, { components: null }]));
});
