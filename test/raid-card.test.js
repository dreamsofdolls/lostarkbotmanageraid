"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { renderRaidStatusCard, CANVAS_W, CANVAS_H } = require("../bot/services/raid-card");

const SAMPLE_INPUT = {
  rosterName: "Test Roster",
  raid: {
    name: "Act 4 Hard",
    icon: "⛔",
    color: "#ed4245",
  },
  cleared: { count: 5, total: 16 },
  characters: [
    {
      name: "TestChar1",
      classId: "berserker",
      itemLevel: 1745.83,
      gates: [{ cleared: true }, { cleared: true }, { cleared: false }, { cleared: false }],
    },
    {
      name: "TestChar2",
      classId: "holyknight",
      itemLevel: 1720.0,
      gates: [{ cleared: true }, { cleared: false }, { cleared: false }, { cleared: false }],
    },
  ],
  lastUpdatedLabel: "2 hours ago",
};

test("renderRaidStatusCard returns a non-empty PNG buffer for the default (no background) path", async () => {
  const buf = await renderRaidStatusCard(SAMPLE_INPUT);
  assert.ok(Buffer.isBuffer(buf), "expected a Buffer return value");
  assert.ok(buf.length > 0, "expected non-empty buffer");
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A. Quick sanity that the
  // bytes we got are actually a PNG header and not, say, a JSON
  // error or zero-length placeholder.
  assert.equal(buf[0], 0x89);
  assert.equal(buf[1], 0x50);
  assert.equal(buf[2], 0x4e);
  assert.equal(buf[3], 0x47);
});

test("renderRaidStatusCard rejects missing required fields", async () => {
  await assert.rejects(
    () => renderRaidStatusCard({}),
    /requires rosterName/,
  );
  await assert.rejects(
    () => renderRaidStatusCard({ rosterName: "X" }),
    /requires rosterName/,
  );
  await assert.rejects(
    () => renderRaidStatusCard({ rosterName: "X", raid: { name: "Y" } }),
    /requires rosterName/,
  );
});

test("renderRaidStatusCard caps visible characters at 6 (no overflow drawing past the canvas)", async () => {
  // Provide 10 characters · the render shouldn't crash on the extras
  // beyond the visible cap. We can't introspect what got drawn from
  // the buffer, but a successful return is the contract.
  const manyChars = Array.from({ length: 10 }, (_, i) => ({
    name: `Char${i}`,
    classId: "berserker",
    itemLevel: 1700 + i,
    gates: [{ cleared: true }, { cleared: false }, { cleared: false }, { cleared: false }],
  }));
  const buf = await renderRaidStatusCard({
    ...SAMPLE_INPUT,
    characters: manyChars,
  });
  assert.ok(buf.length > 0);
});

test("renderRaidStatusCard tolerates characters with unknown classId (no class icon file)", async () => {
  // Resilience check: if the bot ever encounters a classId without a
  // matching PNG (new LA class shipped before assets caught up), the
  // renderer should skip the icon, not throw.
  const buf = await renderRaidStatusCard({
    ...SAMPLE_INPUT,
    characters: [
      {
        name: "UnknownClass",
        classId: "definitely_not_a_real_class_id",
        itemLevel: 1700,
        gates: [{ cleared: false }],
      },
    ],
  });
  assert.ok(buf.length > 0);
});

test("renderRaidStatusCard canvas dimensions are stable (1200x720)", () => {
  // Lock the canvas size so changes to layout don't drift the output
  // resolution without a corresponding update on the Discord-side
  // assumption (1200x720 = 5:3, scales cleanly on mobile + desktop).
  assert.equal(CANVAS_W, 1200);
  assert.equal(CANVAS_H, 720);
});
