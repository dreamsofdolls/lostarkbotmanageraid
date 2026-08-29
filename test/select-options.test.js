"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectEntriesWithPinnedActive,
} = require("../bot/utils/discord/select-options");

test("select entries keep an active item outside the Discord option cap", () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ id: index }));

  const visible = selectEntriesWithPinnedActive(entries, {
    limit: 25,
    activeValue: 28,
    getValue: (entry) => entry.id,
  });

  assert.equal(visible.length, 25);
  assert.deepEqual(visible.slice(0, 24), entries.slice(0, 24));
  assert.equal(visible[24], entries[28]);
  assert.equal(entries[24].id, 24);
});

test("select entries preserve the natural first page when active is visible", () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ id: `u${index}` }));

  const visible = selectEntriesWithPinnedActive(entries, {
    limit: 25,
    activeValue: "u4",
    getValue: (entry) => entry.id,
  });

  assert.deepEqual(visible, entries.slice(0, 25));
});

test("select entries tolerate missing input and an absent active value", () => {
  assert.deepEqual(selectEntriesWithPinnedActive(null), []);
  assert.deepEqual(
    selectEntriesWithPinnedActive([1, 2, 3], { limit: 2, activeValue: 9 }),
    [1, 2]
  );
});
