"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

const {
  buildSeedRosterLink,
  createAddRosterViewBuilders,
} = require("../bot/handlers/roster/add/view");

const UI = {
  colors: { muted: 1, neutral: 2, success: 3 },
  icons: { info: "[info]", roster: "[roster]", warn: "[warn]" },
};

function makeBuilders() {
  const calls = [];
  return {
    calls,
    builders: createAddRosterViewBuilders({
      EmbedBuilder,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      UI,
      t(key, lang, vars = {}) {
        calls.push({ key, lang, vars });
        return `${key}:${lang}`;
      },
    }),
  };
}

test("raid-add roster view builds bible roster links with encoded seed names", () => {
  assert.equal(
    buildSeedRosterLink("Qi ylyn+"),
    "https://lostark.bible/character/NA/Qi%20ylyn%2B/roster"
  );
});

test("raid-add roster view renders picker embed and toggle buttons", () => {
  const { builders } = makeBuilders();
  const session = {
    lang: "en",
    seedCharName: "Qiylyn",
    chars: [
      { charName: "Qiylyn", className: "Artist", itemLevel: 1700, combatScore: "100000" },
      { charName: "Bardly", className: "Bard", itemLevel: 1690, combatScore: "" },
    ],
    selectedIndices: new Set([0]),
    actingForOther: false,
  };

  const embed = builders.buildSelectionEmbed(session).toJSON();
  assert.match(embed.description, /Qiylyn/);
  assert.match(embed.description, /CP `100000`/);

  const rows = builders.buildSelectionComponents(session);
  assert.equal(rows.length, 2);
  const firstButton = rows[0].components[0].toJSON();
  assert.match(firstButton.label, /1\. Qiylyn/);
  assert.equal(firstButton.style, ButtonStyle.Success);
  const confirmButton = rows[1].components[0].toJSON();
  assert.equal(confirmButton.disabled, false);
});

test("raid-add roster saved embed reports target DM failure for manager flow", () => {
  const { builders, calls } = makeBuilders();
  const session = {
    lang: "vi",
    seedCharName: "Qiylyn",
    actingForOther: true,
    callerId: "manager-1",
    targetId: "target-1",
  };
  const savedAccount = {
    accountName: "Qiylyn",
    characters: [{ name: "Qiylyn", class: "Artist", itemLevel: 1700, combatScore: "100000" }],
  };

  builders.buildSavedEmbed(session, savedAccount, { reason: "dms-disabled" }).toJSON();

  assert.ok(calls.some((call) => call.key === "raid-add-roster.saved.dmDisabled"));
});
