"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAllModePageRenderers,
  displayNameForUser,
} = require("../bot/handlers/raid-check/all-mode/all-mode-render");

class FakeEmbedBuilder {
  constructor() {
    this.data = { fields: [] };
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

  setFooter(footer) {
    this.data.footer = footer;
    return this;
  }

  setAuthor(author) {
    this.data.author = author;
    return this;
  }

  addFields(...fields) {
    this.data.fields.push(...fields);
    return this;
  }
}

test("all-mode render display name prefers resolved Discord meta", () => {
  assert.equal(
    displayNameForUser({ discordId: "u1", discordUsername: "Saved" }, { displayName: "Fetched" }),
    "Fetched"
  );
  assert.equal(displayNameForUser({ discordId: "u1", discordUsername: "Saved" }, null), "Saved");
  assert.equal(displayNameForUser({ discordId: "u1" }, null), "<@u1>");
});

test("all-mode task page renders current account identity and read-only footer", () => {
  const pagesData = [
    {
      userDoc: { discordId: "u1", discordUsername: "Saved" },
      account: { accountName: "Roster", characters: [] },
    },
  ];
  const { buildTaskPage } = createAllModePageRenderers({
    EmbedBuilder: FakeEmbedBuilder,
    UI: { icons: { done: "done", pending: "pending", reset: "reset" } },
    authorMeta: new Map([["u1", { displayName: "Fetched", avatarURL: "avatar.png" }]]),
    buildAccountPageEmbed: () => new FakeEmbedBuilder(),
    buildStatusFooterText: () => "footer",
    getState: () => ({
      currentLocalPage: 0,
      filterRaidId: null,
      filterUserId: null,
      filteredIndices: [0],
      totalPages: 1,
    }),
    getStatusRaidsForCharacter: () => [],
    isManagerId: () => false,
    lang: "en",
    pagesData,
    summarizeRaidProgress: () => ({ completed: 0, total: 0 }),
    truncateText: (value) => String(value),
  });

  const embed = buildTaskPage(0);

  assert.match(embed.data.title, /Fetched/);
  assert.match(embed.data.title, /Roster/);
  assert.deepEqual(embed.data.author, { name: "Fetched", iconURL: "avatar.png" });
  assert.ok(embed.data.footer.text.length > 0);
});
