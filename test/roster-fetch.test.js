"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRosterFetchService } = require("../bot/services/roster/fetch");

// lostark.bible renders a card only for characters it updated recently,
// while the page's data payload lists the whole roster.
function rosterPage({ cards, payload }) {
  const cardHtml = cards.map(({ name, ilvl, cp }) =>
    `<a href="/character/NA/${name}"><div class="flex flex-row items-center gap-1 text-lg font-semibold">${name} `
    + `<span class="rounded-full">${ilvl}</span> <span class="inline-flex">${cp}</span></div></a>`).join("");
  return `<html><body>${cardHtml}<script>data:{roster:[${payload.join(",")}]}</script></body></html>`;
}

async function fetchRoster(t, html) {
  t.mock.method(globalThis, "fetch", async () => new Response(html));
  const { fetchRosterCharacters } = createRosterFetchService({ bibleLimiter: { run: (fn) => fn() } });
  return fetchRosterCharacters("Alpha");
}

const ALPHA = '{id:1,name:"Alpha",class:"blade",ilvl:1740.8334,combatPower:{id:1,score:3264.49},combatPowerIsEstimate:true,lastUpdate:1792166510}';
const BETA = '{id:2,name:"Beta",class:"devil_hunter_female",ilvl:1722.5,combatPower:{id:1,score:2741.46},combatPowerIsEstimate:true,lastUpdate:1790173822}';
const GAMMA = '{id:3,name:"Gamma",class:"holyknight",ilvl:1710.8334,combatPower:{id:1,score:1617.64},combatPowerIsEstimate:false,lastUpdate:1792166888}';
const DELTA = '{id:4,name:"Delta",class:"warlord",ilvl:1643.5,combatPower:null,combatPowerIsEstimate:true,lastUpdate:1753335714}';

test("a roster character bible shows no card for is still fetched, in item level order", async (t) => {
  const characters = await fetchRoster(t, rosterPage({
    cards: [{ name: "Alpha", ilvl: "1740.83", cp: "≈3264.49" }, { name: "Gamma", ilvl: "1710.83", cp: "1617.64" }],
    payload: [ALPHA, BETA, GAMMA, DELTA],
  }));

  assert.deepEqual(characters.map((c) => c.charName), ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.deepEqual(characters[1], { charName: "Beta", className: "Gunslinger", itemLevel: 1722.5, combatScore: "≈2741.46" });
  assert.equal(characters[3].className, "Gunlancer");
  assert.equal(characters[3].combatScore, "?");
});

test("a roster page with no character cards still fetches no characters", async (t) => {
  assert.deepEqual(await fetchRoster(t, rosterPage({ cards: [], payload: [ALPHA, BETA] })), []);
});
