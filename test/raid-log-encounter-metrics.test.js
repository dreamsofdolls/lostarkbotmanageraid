"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { readEncounterLiteral, supportSharesFromEncounter, MAX_ENCOUNTER_LENGTH } = require("../bot/services/raid-log/encounter-metrics");

const players = [
  { id: "1-3", label: "1773.33 Paladin #1", className: "Paladin" },
  { id: "2-3", label: "1757.5 Paladin #2", className: "Paladin" },
  { id: "1-0", label: "1760 Dps", className: "Aeromancer" },
];
const support = (name, skills) => ({ id: 0, name, class: "Paladin", entityType: "PLAYER", skills });
const data = () => ({ id: "public-log", encounter: { encounterDamageStats: { totalDamageDealt: 900 }, entityList: [
  support("Paladin #1", { a: { rdpsContributed: { 1: 100, 2: 900, 3: 150, 5: 50, 6: 900 } }, b: { rdpsContributed: { 1: 18 } } }),
  support("Paladin #2", { a: { rdpsContributed: { 3: 143 } } }),
] } });
const options = { logId: "public-log", summary: "Duration: 9:21\nTotal DMG: 1,000\nTeam DPS: 1", players };
const shares = encounter => supportSharesFromEncounter(JSON.stringify(encounter), options);

test("anonymous supports sharing an id match by public name/class; only categories 1/3/5 contribute", () => {
  assert.deepEqual([...shares(data())], [["1-3", 31.8], ["2-3", 14.3]]);
  assert.deepEqual([...supportSharesFromEncounter(JSON.stringify(data()), { ...options, summary: "Total DMG: 900" })],
    [["1-3", 35.3], ["2-3", 15.9]], "displayed total, including Esther when shown, is authoritative");
});

test("ambiguous identities, class mismatches and missing/invalid contributions never get guessed", () => {
  const duplicate = data();
  duplicate.encounter.entityList.push(duplicate.encounter.entityList[0]);
  assert.deepEqual([...shares(duplicate)], [["2-3", 14.3]]);
  for (const mutate of [entity => { entity.class = "Bard"; }, entity => { entity.entityType = "NPC"; },
    entity => { entity.name = "Someoneelse"; }, entity => { delete entity.skills; },
    entity => { entity.skills = { a: {} }; }, entity => { entity.skills.a.rdpsContributed[1] = -1; },
    entity => { entity.skills.a.rdpsContributed[1] = "100"; }]) {
    const encounter = data(); mutate(encounter.encounter.entityList[0]);
    assert.deepEqual([...shares(encounter)], [["2-3", 14.3]]);
  }
});

test("wrong log ids, incompatible data, abbreviated totals and oversized data yield no shares", () => {
  for (const literal of [null, 96, "x".repeat(MAX_ENCOUNTER_LENGTH + 1), '{}', '{id:"different",encounter:{entityList:[]}}']) {
    assert.equal(supportSharesFromEncounter(literal, options).size, 0);
  }
  for (const summary of [undefined, "Total DMG: 1.2b", "Total DMG: 0", "Total DMG: NaN"]) {
    assert.equal(supportSharesFromEncounter(JSON.stringify(data()), { ...options, summary }).size, 0);
  }
});

test("Svelte object extraction respects quoted braces and escapes, and parses JSON5 without executing script", () => {
  const dom = new JSDOM("<script src='/ignore.js'></script><script id='boot'></script>", { runScripts: "outside-only" });
  const literal = `{id:'public-log',note:'a } \\' { brace',encounter:{entityList:[]},score:.5}`;
  dom.window.document.querySelector("#boot").textContent = `kit.start(app,element,{data:[{data:{encounterInfo:${literal},views:7}}]});`;
  try {
    const extract = dom.window.eval(`(${readEncounterLiteral.toString()})`);
    assert.equal(extract(MAX_ENCOUNTER_LENGTH), literal);
    assert.equal(supportSharesFromEncounter(literal, options).size, 0);
    assert.equal(extract(32), null);
    dom.window.document.querySelector("#boot").textContent = "kit.start(app,element,{encounterInfo:{id:'unfinished'";
    assert.equal(extract(MAX_ENCOUNTER_LENGTH), null);
    assert.throws(() => supportSharesFromEncounter("{id:(globalThis.executed = true)}", options), SyntaxError);
    assert.equal(globalThis.executed, undefined);
  } finally { dom.window.close(); }
});
