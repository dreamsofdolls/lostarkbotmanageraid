"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { readPartyMetrics, readSupportShare } = require("../bot/services/raid-log/metrics");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", "raid-log", name), "utf8");
// page.evaluate hands back plain JSON; doing the same keeps the page's objects
// comparable with this realm's in deepEqual.
function run(html, fn, prepare = () => {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  try {
    prepare(dom.window.document);
    return JSON.parse(JSON.stringify(dom.window.eval(`(${fn.toString()})()`)));
  } finally {
    dom.window.close();
  }
}

test("party figures come from the real Bible tables in party order", () => {
  const rows = run(fixture("zEn59i4-overview-bracketed.html"), readPartyMetrics);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[0], { id: "1-0", label: "1760 Qiylyn", className: "Aeromancer", badges: [99],
    dps: 1.06e9, ndps: 385.7e6, contribution: 63.6, damageShare: 24.6, stagger: 3500, counters: 3 });
  assert.deepEqual(rows[3], { id: "1-3", label: "1755 Canameo", className: "Bard", badges: [82, 91],
    dps: 4.2e6, ndps: 3.6e6, contribution: 51.1, damageShare: 0.1, stagger: 2000, counters: 2 });
  assert.deepEqual(rows.map(row => row.id), ["1-0", "1-1", "1-2", "1-3", "2-0", "2-1", "2-2", "2-3"]);
});

test("columns are found by colSpan position, not by header index", () => {
  // The name cell spans two header columns, so by plain index D% would read the CRIT cell (95%).
  const [qiylyn] = run(fixture("zEn59i4-overview-bracketed.html"), readPartyMetrics);
  assert.equal(qiylyn.damageShare, 24.6);
  assert.equal(qiylyn.counters, 3);
});

test("Normalized changes dealer badges only", () => {
  const rows = run(fixture("zEn59i4-overview-normalized.html"), readPartyMetrics);
  assert.deepEqual(rows.map(row => row.badges), [[99], [60], [99], [82, 91], [58], [69], [16], [76, 83]]);
});

test("a column Bible stops printing reads as null and the rest still parse", () => {
  const rows = run(fixture("zEn59i4-overview-bracketed.html"), readPartyMetrics, document => {
    for (const cell of document.querySelectorAll("thead th")) if (cell.textContent.trim() === "CTR") cell.textContent = "";
  });
  assert.ok(rows.every(row => row.counters === null));
  assert.equal(rows[0].damageShare, 24.6);
});

test("support bD% is the first row's figure on the detail view, null elsewhere", () => {
  assert.equal(run(fixture("zEn59i4-support-canameo.html"), readSupportShare), 31.8);
  assert.equal(run(fixture("zEn59i4-overview-bracketed.html"), readSupportShare), null);
  assert.equal(run(fixture("zEn59i4-support-canameo.html"), readSupportShare, document => {
    for (const cell of document.querySelectorAll("thead th")) if (cell.textContent.trim() === "bD%") cell.textContent = "";
  }), null);
});
