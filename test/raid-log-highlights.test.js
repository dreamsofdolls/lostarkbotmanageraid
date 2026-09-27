"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickHighlights } = require("../bot/services/raid-log/highlights");

// Log zEn59i4 as read from Bible (test/fixtures/raid-log): party order, both badge sets.
const TEAM = [
  ["1-0", "1760 Qiylyn", "Aeromancer", [99], [99], 24.6, 3, 3500, 1.06e9, 385.7e6, 63.6, null],
  ["1-1", "1780 Bánhcanhcüa", "Glaivier", [63], [60], 23, 0, 4300, 991.3e6, 389.8e6, 60.6, null],
  ["1-2", "1751.66 Thinkingofyou", "Wildsoul", [97], [99], 18.7, 1, 4900, 804.9e6, 275.9e6, 65.7, null],
  ["1-3", "1755 Canameo", "Bard", [82, 91], [82, 91], 0.1, 2, 2000, 4.2e6, 3.6e6, 51.1, 31.8],
  ["2-0", "1742.5 Vynxpaul", "Summoner", [59], [58], 12.9, 2, 4500, 555e6, 219.4e6, 60.4, null],
  ["2-1", "1746.66 Slayer #1", "Slayer", [80], [69], 11, 0, 3600, 473.2e6, 211.3e6, 55.3, null],
  ["2-2", "1734.16 Gunslinger #2", "Gunslinger", [37], [16], 9.7, 1, 3000, 420.5e6, 168.5e6, 59.9, null],
  ["2-3", "1732.5 Yzan", "Bard", [76, 83], [76, 83], 0.1, 2, 2200, 4.5e6, 4e6, 47.2, 14.3],
].map(([id, label, className, bracketed, normalized, damageShare, counters, stagger, dps, ndps, contribution, buffedShare]) => ({
  id, party: Number(id[0]), row: Number(id[2]), label, className, badges: { bracketed, normalized },
  damageShare, counters, stagger, dps, ndps, contribution, buffedShare,
}));
const labelOf = pick => pick?.player.label;

test("the real log picks Qiylyn for every dealer field and Canameo for every support field", () => {
  const h = pickHighlights(TEAM, true);
  assert.deepEqual([labelOf(h.damage), h.damage.share], ["1760 Qiylyn", 24.6]);
  assert.deepEqual([labelOf(h.dealerScore), h.dealerScore.badge, h.dealerScore.ndps], ["1760 Qiylyn", 99, 385.7e6]);
  assert.deepEqual([labelOf(h.counter), h.counter.counters, h.counter.tied], ["1760 Qiylyn", 3, false]);
  assert.deepEqual([labelOf(h.support), h.support.share], ["1755 Canameo", 31.8]);
  assert.deepEqual([labelOf(h.supportContribution), h.supportContribution.badge, h.supportContribution.contribution], ["1755 Canameo", 82, 51.1]);
  assert.deepEqual([labelOf(h.supportUptime), h.supportUptime.badge], ["1755 Canameo", 91]);
});

test("Normalized ties on the dealer badge break on nDPS", () => {
  const h = pickHighlights(TEAM, false);
  assert.equal(h.dealerScore.badge, 99);
  assert.equal(labelOf(h.dealerScore), "1760 Qiylyn");
  const swapped = TEAM.map(p => (p.id === "1-2" ? { ...p, ndps: 400e6 } : p));
  assert.equal(labelOf(pickHighlights(swapped, false).dealerScore), "1751.66 Thinkingofyou");
});

test("MVP Counter is one player: counters, then stagger, then D%, then table order", () => {
  const tied = TEAM.map(p => (p.id === "1-0" ? { ...p, counters: 2 } : p));
  const h = pickHighlights(tied, true);
  assert.deepEqual([labelOf(h.counter), h.counter.counters, h.counter.stagger, h.counter.tied], ["1742.5 Vynxpaul", 2, 4500, true]);
  const sameStagger = TEAM.map(p => (["1-3", "2-3"].includes(p.id) ? { ...p, counters: 5, stagger: 2000 } : p));
  assert.equal(labelOf(pickHighlights(sameStagger, true).counter), "1755 Canameo");
  assert.equal(pickHighlights(TEAM.map(p => ({ ...p, counters: 0 })), true).counter, null);
});

test("a log without supports leaves every support pick empty", () => {
  const dealers = TEAM.filter(p => p.className !== "Bard");
  const h = pickHighlights(dealers, true);
  assert.deepEqual([h.support, h.supportContribution, h.supportUptime], [null, null, null]);
  assert.equal(labelOf(h.damage), "1760 Qiylyn");
});

test("a missing main figure sorts last and the tie-break still names someone", () => {
  const noShares = TEAM.map(p => ({ ...p, buffedShare: null }));
  const h = pickHighlights(noShares, true);
  assert.deepEqual([labelOf(h.support), h.support.share], ["1755 Canameo", null]);
  const partial = TEAM.map(p => (p.id === "1-3" ? { ...p, buffedShare: null } : p));
  assert.equal(labelOf(pickHighlights(partial, true).support), "1732.5 Yzan");
  assert.deepEqual(pickHighlights(undefined), { damage: null, dealerScore: null, counter: null, support: null, supportContribution: null, supportUptime: null });
});
