"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");

const {
  computeBulkGoldModeOptions,
  computeGoldReceiveOptions,
  goldReceiveDefaults,
} = require("../bot/handlers/raid-status/gold/gold-ui/toggle-rows");
const { createGoldFilterState } = require("../bot/handlers/raid-status/gold/gold-ui/filters");
const { createRaidStatusGoldUi } = require("../bot/handlers/raid-status/gold/gold-ui");
const { getStatusRaidsForCharacter } = require("../bot/utils/raid/common/character");
const { UI, formatGold, truncateText } = require("../bot/utils/raid/common/shared");

const cleared = { difficulty: "Normal", completedDate: 1 };

function char(name, itemLevel, assignedRaids = {}) {
  return { name, class: "Bard", itemLevel, assignedRaids };
}

function entryOf(character) {
  return {
    name: character.name,
    itemLevel: character.itemLevel,
    raids: getStatusRaidsForCharacter(character),
  };
}

function exampleCharacters() {
  return [
    char("Soulrano", 1771, {
      armoche: { modeKey: "normal" }, kazeros: { modeKey: "normal" }, belgardin: { modeKey: "normal" },
    }),
    char("Nailaduk", 1772, {
      armoche: { modeKey: "normal" },
      kazeros: { modeKey: "normal", G1: cleared },
      belgardin: { modeKey: "normal", G1: cleared },
    }),
    char("Priscilladuk", 1765, {
      armoche: { modeKey: "normal" }, kazeros: { modeKey: "normal" }, belgardin: { modeKey: "normal" },
    }),
  ];
}

// ─── option builders ───

test("computeBulkGoldModeOptions counts eligible and deferred characters", () => {
  const options = computeBulkGoldModeOptions(exampleCharacters().map(entryOf));
  const byValue = Object.fromEntries(options.map((option) => [option.value, option]));

  const belgardinHard = byValue["belgardin::hard"];
  assert.ok(belgardinHard);
  assert.equal(belgardinHard.minItemLevel, 1770);
  assert.equal(belgardinHard.eligible, 2);
  assert.equal(belgardinHard.total, 3);
  assert.equal(belgardinHard.deferred, 1);
  assert.equal(belgardinHard.direction, "up");

  assert.equal(byValue["belgardin::normal"], undefined, "every eligible character already targets it");
  assert.equal(byValue["armoche::normal"], undefined);
  assert.ok(options.length <= 25);
});

test("computeBulkGoldModeOptions adds one cancel option per raid with a pending change", () => {
  const characters = exampleCharacters();
  characters[1].assignedRaids.kazeros.pendingModeKey = "hard";
  const options = computeBulkGoldModeOptions(characters.map(entryOf));
  const cancel = options.find((option) => option.value === "kazeros::cancel");
  assert.ok(cancel);
  assert.equal(cancel.isCancel, true);
  assert.equal(cancel.pending, 1);

  const kazerosHard = options.find((option) => option.value === "kazeros::hard");
  assert.equal(kazerosHard.eligible, 3);
  assert.equal(kazerosHard.deferred, 0, "the character that already queued Hard is not counted again");
});

test("computeGoldReceiveOptions pre-ticks raids every selected character receives", () => {
  // Both auto: Kazeros Hard, Serca Nightmare, Belgardin Hard are the largest unbound totals.
  const entries = [char("A", 1771), char("B", 1772)].map(entryOf);
  const options = computeGoldReceiveOptions(entries);
  assert.deepEqual(options.map((option) => option.value), [
    "armoche", "kazeros", "serca", "horizon", "belgardin", "auto",
  ]);
  assert.deepEqual(goldReceiveDefaults(entries), ["kazeros", "serca", "belgardin"]);
  const auto = options[options.length - 1];
  assert.equal(auto.isAuto, true);
  assert.equal(auto.default, false);
  const kazeros = options.find((option) => option.value === "kazeros");
  assert.equal(kazeros.receiving, 2);
  assert.equal(kazeros.has, 2);
  assert.equal(kazeros.total, 2);
});

test("computeGoldReceiveOptions counts characters that lack a raid", () => {
  const entries = [char("High", 1771), char("Low", 1745)].map(entryOf);
  const belgardin = computeGoldReceiveOptions(entries).find((option) => option.value === "belgardin");
  assert.equal(belgardin.has, 1);
  assert.equal(belgardin.total, 2);
  assert.equal(belgardin.default, false);
});

test("computeGoldReceiveOptions pre-ticks nothing when the selected characters receive different sets", () => {
  // High receives Belgardin, which Low cannot run. The raids both receive
  // describe neither character, so pre-ticking them would make a deliberate
  // pick of exactly that set look like an unchanged close.
  const entries = [char("High", 1771), char("Low", 1745)].map(entryOf);
  const receiving = entries.map((entry) => entry.raids.filter((raid) => raid.goldReceives).length);
  assert.ok(receiving.every((count) => count > 0));
  assert.deepEqual(goldReceiveDefaults(entries), []);
  assert.ok(computeGoldReceiveOptions(entries).every((option) => option.default === false));
});

// ─── selection state ───

test("gold selection is kept per page and drops vanished names", () => {
  const selections = new Map([[0, ["Ghost", "Nailaduk"]]]);
  let page = 0;
  const accounts = [
    { accountName: "A", characters: exampleCharacters() },
    { accountName: "B", characters: [char("Clauseduk", 1780)] },
  ];
  const state = createGoldFilterState({
    getAccounts: () => accounts,
    getCurrentPage: () => page,
    getGoldCharSelection: (p) => selections.get(p),
    getCharacterName: (character) => character.name,
    getRaidsFor: getStatusRaidsForCharacter,
  });
  assert.deepEqual(state.resolveGoldCharSelection(), ["Nailaduk"]);
  page = 1;
  assert.deepEqual(state.resolveGoldCharSelection(), ["Clauseduk"]);
  page = 0;
  selections.set(0, ["Ghost"]);
  assert.deepEqual(state.resolveGoldCharSelection(), ["Soulrano"]);
});

// ─── rows and embed ───

function goldUiFor(selected) {
  const accounts = [{ accountName: "Perfectwings", characters: exampleCharacters() }];
  return createRaidStatusGoldUi({
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName: (character) => character.name,
    truncateText,
    formatGold,
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getGoldCharSelection: () => selected,
    getRaidsFor: getStatusRaidsForCharacter,
    lang: "vi",
  });
}

for (const selected of [["Soulrano"], ["Soulrano", "Nailaduk", "Priscilladuk"]]) {
  test(`every gold row keeps defaults within max_values (${selected.length} selected)`, () => {
    const ui = goldUiFor(selected);
    const rows = [ui.buildGoldCharsRow(false), ui.buildGoldReceiveRow(false), ui.buildGoldModeRow(false)];
    assert.deepEqual(
      rows.map((row) => row.toJSON().components[0].custom_id),
      ["status-gold:chars", "status-gold:receive", "status-gold:mode"],
    );
    for (const row of rows) {
      const select = row.toJSON().components[0];
      const defaults = select.options.filter((option) => option.default).length;
      assert.equal(select.min_values, 1, select.custom_id);
      assert.ok(defaults <= select.max_values, `${select.custom_id} defaults ${defaults} > max ${select.max_values}`);
      assert.ok(select.max_values <= select.options.length, select.custom_id);
      assert.ok(select.options.length <= 25, select.custom_id);
    }
    const chars = rows[0].toJSON().components[0];
    assert.deepEqual(chars.options.filter((option) => option.default).map((option) => option.value), selected);
  });
}

test("the gold set row allows at most three raids", () => {
  const select = goldUiFor(["Soulrano"]).buildGoldReceiveRow(false).toJSON().components[0];
  assert.equal(select.max_values, 3);
});

test("selected characters carry the ✏️ marker in the gold embed", () => {
  const embed = goldUiFor(["Nailaduk"]).buildGoldViewEmbed({
    accountName: "Perfectwings",
    characters: exampleCharacters(),
  }).toJSON();
  const names = embed.fields.map((field) => field.name).filter((name) => /duk|rano/.test(name));
  assert.ok(names.some((name) => name.startsWith("✏️ ") && /Nailaduk/.test(name)));
  assert.ok(names.filter((name) => !/Nailaduk/.test(name)).every((name) => !name.startsWith("✏️")));
});
