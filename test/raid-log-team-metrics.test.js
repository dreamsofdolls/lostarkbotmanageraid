"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { collectTeamMetrics } = require("../bot/services/raid-log/team-metrics");
const { readPartyMetrics } = require("../bot/services/raid-log/metrics");
const { silentLog } = require("./helpers/silent-log");
const { readEncounterLiteral } = require("../bot/services/raid-log/encounter-metrics");
const options = { logId: "testlog", summary: "Total DMG: 1,000", log: silentLog };

const PLAYERS = [
  { id: "1-0", party: 1, row: 0, label: "1760 Qiylyn", className: "Aeromancer" },
  { id: "1-3", party: 1, row: 3, label: "1755 Canameo", className: "Bard" },
  { id: "2-3", party: 2, row: 3, label: "1732.5 Yzan", className: "Bard" },
];
const figures = { dps: 1, ndps: 2, contribution: 3, damageShare: 4, stagger: 5, counters: 6 };
const rowsFor = normalized => PLAYERS.map(p => ({ id: p.id, label: p.label, className: p.className,
  badges: p.className === "Bard" ? [82, 91] : [normalized ? 98 : 99], ...figures }));

function fakePage({ startNormalized = false, literal, hasNormalized = true } = {}) {
  const state = { normalized: startNormalized, readEncounter: 0, readParties: 0 };
  const encounter = literal === undefined ? JSON.stringify({ id: "testlog", encounter: { entityList: [
    { name: "Canameo", class: "Bard", entityType: "PLAYER", skills: { one: { rdpsContributed: { 1: 318 } } } },
    { name: "Yzan", class: "Bard", entityType: "PLAYER", skills: { one: { rdpsContributed: { 3: 143 } } } },
  ] } }) : literal;
  const page = {
    evaluate: async fn => {
      if (fn === readPartyMetrics) { state.readParties++; return rowsFor(state.normalized); }
      if (fn === readEncounterLiteral) { state.readEncounter++; return encounter; }
      throw new Error("unexpected evaluate");
    },
    getByRole: (role, { name }) => {
      assert.equal(role, "switch", "metrics never open a detail view or return to overview");
      return { count: async () => Number(hasNormalized), isChecked: async () => { assert.ok(hasNormalized); return state.normalized; } };
    },
    locator: () => ({ filter: () => ({ click: async () => { state.normalized = !state.normalized; } }) }),
    waitForFunction: async () => {},
  };
  return { page, state };
}

test("figures and support shares merge without entering detail, ending on the Bracketed overview", async () => {
  const { page, state } = fakePage({ startNormalized: true });
  const players = await collectTeamMetrics(page, PLAYERS, options);
  assert.deepEqual(players[0].badges, { bracketed: [99], normalized: [98] });
  assert.equal(players[0].damageShare, 4);
  assert.deepEqual(players.map(p => p.buffedShare), [null, 31.8, 14.3]);
  assert.equal(state.readEncounter, 1);
  assert.equal(state.normalized, false);
});

test("missing or changed encounter data preserves other metrics without a detail fallback", async () => {
  const warnings = [];
  for (const literal of [null, "{id:broken()}", '{id:"another-log"}']) {
    const { page, state } = fakePage({ literal });
    const players = await collectTeamMetrics(page, PLAYERS, { ...options,
      log: { warn: message => warnings.push(message) } });
    assert.deepEqual(players.map(p => p.buffedShare), [null, null, null]);
    assert.equal(players[1].contribution, 3);
    assert.deepEqual(players[1].badges, { bracketed: [82, 91], normalized: [82, 91] });
    assert.equal(state.normalized, false);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /embedded support metrics unavailable/);
});

test("a support slot whose name changed since the baseline gets no figures or share", async () => {
  const { page } = fakePage();
  const moved = PLAYERS.map(p => p.id === "1-3" ? { ...p, label: "1755 Someoneelse" } : p);
  const players = await collectTeamMetrics(page, moved, options);
  assert.deepEqual(players[1].badges, { bracketed: [], normalized: [] });
  assert.equal(players[1].damageShare, undefined);
  assert.equal(players[1].buffedShare, null);
});

test("a team without supports does not transfer encounter data", async () => {
  const { page, state } = fakePage();
  await collectTeamMetrics(page, [PLAYERS[0]], options);
  assert.equal(state.readEncounter, 0);
});

test("no players means no page work", async () => {
  const page = { evaluate: async () => assert.fail("no evaluate expected") };
  assert.deepEqual(await collectTeamMetrics(page, [], options), []);
});

test("legacy logs read team figures once without waiting for an absent percentile switch", async () => {
  const { page, state } = fakePage({ hasNormalized: false });
  const players = await collectTeamMetrics(page, PLAYERS, options);
  assert.equal(state.readParties, 1);
  assert.equal(state.normalized, false);
  assert.equal(players[0].dps, 1);
  assert.deepEqual(players[0].badges.normalized, []);
  assert.deepEqual(players.map(player => player.buffedShare), [null, 31.8, 14.3]);
});
