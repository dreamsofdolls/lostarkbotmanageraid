"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectTeamMetrics } = require("../bot/services/raid-log/team-metrics");
const { readPartyMetrics, readSupportShare } = require("../bot/services/raid-log/metrics");
const { silentLog } = require("./helpers/silent-log");

const PLAYERS = [
  { id: "1-0", party: 1, row: 0, label: "1760 Qiylyn", className: "Aeromancer" },
  { id: "1-3", party: 1, row: 3, label: "1755 Canameo", className: "Bard" },
  { id: "2-3", party: 2, row: 3, label: "1732.5 Yzan", className: "Bard" },
];
const figures = { dps: 1, ndps: 2, contribution: 3, damageShare: 4, stagger: 5, counters: 6 };
const rowsFor = normalized => PLAYERS.map(p => ({ id: p.id, label: p.label, className: p.className,
  badges: p.className === "Bard" ? [82, 91] : [normalized ? 98 : 99], ...figures }));

function fakePage({ startNormalized = false, shares = { "1-3": 31.8, "2-3": 14.3 }, failOpen = [] } = {}) {
  const state = { normalized: startNormalized, detail: null, opened: [] };
  const page = {
    evaluate: async fn => {
      if (fn === readPartyMetrics) return rowsFor(state.normalized);
      if (fn === readSupportShare) return shares[state.detail] ?? null;
      throw new Error("unexpected evaluate");
    },
    getByRole: (role, { name }) => ({
      isChecked: async () => state.normalized,
      count: async () => (name === "Return to Overview" && state.detail ? 1 : 0),
      click: async () => { if (name === "Return to Overview") state.detail = null; },
    }),
    // The label around the switch, and the party table waited on after returning.
    locator: () => ({ filter: () => ({ click: async () => { state.normalized = !state.normalized; }, waitFor: async () => {} }) }),
    waitForFunction: async () => {},
  };
  const openPlayer = async (_, player) => {
    state.opened.push(player.id);
    state.detail = player.id;
    if (failOpen.includes(player.id)) throw new Error("click missed");
    return true;
  };
  return { page, state, openPlayer };
}

test("figures merge by slot with both badge sets and each support's bD%, ending on the Bracketed overview", async () => {
  const { page, state, openPlayer } = fakePage({ startNormalized: true });
  const players = await collectTeamMetrics(page, PLAYERS, { deadline: Date.now() + 60_000, log: silentLog, openPlayer });
  assert.deepEqual(players[0].badges, { bracketed: [99], normalized: [98] });
  assert.equal(players[0].damageShare, 4);
  assert.equal(players[0].buffedShare, null);
  assert.deepEqual(players.map(p => p.buffedShare), [null, 31.8, 14.3]);
  assert.deepEqual(state.opened, ["1-3", "2-3"]);
  assert.equal(state.normalized, false);
  assert.equal(state.detail, null);
});

test("a support whose detail view fails keeps bD% empty and the rest still read", async () => {
  const warnings = [];
  const { page, state, openPlayer } = fakePage({ failOpen: ["1-3"] });
  const players = await collectTeamMetrics(page, PLAYERS, { deadline: Date.now() + 60_000, openPlayer,
    log: { ...silentLog, warn: message => warnings.push(message) } });
  assert.deepEqual(players.map(p => p.buffedShare), [null, null, 14.3]);
  assert.match(warnings[0], /support share unavailable player=1-3/);
  assert.equal(state.detail, null);
});

test("close to the deadline no support page is opened", async () => {
  const { page, state, openPlayer } = fakePage();
  const players = await collectTeamMetrics(page, PLAYERS, { deadline: 10_000, now: () => 6_000, log: silentLog, openPlayer });
  assert.deepEqual(state.opened, []);
  assert.deepEqual(players.map(p => p.buffedShare), [null, null, null]);
});

test("a slot whose name changed since the baseline gets no figures", async () => {
  const { page, openPlayer } = fakePage();
  const moved = PLAYERS.map(p => (p.id === "1-0" ? { ...p, label: "1760 Someoneelse" } : p));
  const [first] = await collectTeamMetrics(page, moved, { deadline: Date.now() + 60_000, log: silentLog, openPlayer });
  assert.deepEqual(first.badges, { bracketed: [], normalized: [] });
  assert.equal(first.damageShare, undefined);
});

test("no players means no page work", async () => {
  const page = { evaluate: async () => assert.fail("no evaluate expected") };
  assert.deepEqual(await collectTeamMetrics(page, [], { deadline: Date.now() + 60_000, log: silentLog }), []);
});
