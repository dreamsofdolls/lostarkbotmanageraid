"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRaidCheckEditDMEmbed,
  getRaidCheckEditDmActionLine,
} = require("../bot/handlers/raid-check/edit/edit-ui/dm");

class FakeEmbedBuilder {
  constructor() {
    this.data = {};
  }

  setColor(color) {
    this.data.color = color;
    return this;
  }

  setTitle(title) {
    this.data.title = title;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  setTimestamp() {
    this.data.timestamp = true;
    return this;
  }
}

const UI = {
  colors: {
    progress: 0x123456,
    success: 0xabcdef,
  },
  icons: {
    done: "[done]",
    warn: "[warn]",
  },
};

const targetChar = {
  charName: "Qiylyn",
  itemLevel: 1700,
};

const raidMeta = {
  raidKey: "act4",
  modeKey: "normal",
};

test("raid-check edit DM action line maps status types without chained conditionals", () => {
  assert.match(
    getRaidCheckEditDmActionLine({ statusType: "complete", lang: "en" }),
    /Marked all gates as done/
  );
  assert.match(
    getRaidCheckEditDmActionLine({ statusType: "reset", lang: "en" }),
    /Reset to 0/
  );
  assert.match(
    getRaidCheckEditDmActionLine({
      statusType: "process",
      gate: "G2",
      lang: "en",
    }),
    /Marked \*\*G2\*\* as done/
  );
});

test("raid-check edit DM embed renders reset color and mode-wipe note", () => {
  const embed = buildRaidCheckEditDMEmbed({
    EmbedBuilder: FakeEmbedBuilder,
    UI,
    targetChar,
    raidMeta,
    statusType: "reset",
    gate: null,
    modeResetHappened: true,
    lang: "en",
  });

  assert.equal(embed.data.color, UI.colors.progress);
  assert.match(embed.data.title, /\[done\]/);
  assert.match(embed.data.description, /Qiylyn/);
  assert.match(embed.data.description, /Reset to 0/);
  assert.match(embed.data.description, /\[warn\]/);
});

test("raid-check edit DM embed renders success color for completion", () => {
  const embed = buildRaidCheckEditDMEmbed({
    EmbedBuilder: FakeEmbedBuilder,
    UI,
    targetChar,
    raidMeta,
    statusType: "complete",
    gate: null,
    modeResetHappened: false,
    lang: "en",
  });

  assert.equal(embed.data.color, UI.colors.success);
  assert.match(embed.data.description, /Marked all gates as done/);
  assert.doesNotMatch(embed.data.description, /\[warn\]/);
});
