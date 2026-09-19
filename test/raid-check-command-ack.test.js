"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} = require("discord.js");

const {
  createRaidCheckCommand,
} = require("../bot/handlers/raid-check");
const {
  clearUserLanguageCache,
} = require("../bot/services/i18n");

test("raid-check acknowledges before the first language lookup, including denied users", async () => {
  clearUserLanguageCache();
  const events = [];
  const User = {
    findOne() {
      return {
        lean: async () => {
          events.push("language");
          return { language: "vi" };
        },
      };
    },
  };
  const interaction = {
    user: { id: "denied-user" },
    deferReply: async () => {
      events.push("defer");
    },
    editReply: async () => {
      events.push("edit");
    },
    reply: async () => {
      events.push("reply");
    },
  };
  const command = createRaidCheckCommand({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    User,
    isRaidLeader: () => false,
    RAID_REQUIREMENT_MAP: {},
  });

  await command.handleRaidCheckCommand(interaction);

  assert.deepEqual(events, ["defer", "language", "edit"]);
});

test("raid-check denied button acknowledges before the language lookup", async () => {
  clearUserLanguageCache();
  const events = [];
  const User = {
    findOne() {
      return {
        lean: async () => {
          events.push("language");
          return { language: "vi" };
        },
      };
    },
  };
  const interaction = {
    customId: "raid-check:sync-all",
    user: { id: "denied-button-user" },
    deferReply: async () => {
      events.push("defer");
    },
    editReply: async () => {
      events.push("edit");
    },
    reply: async () => {
      events.push("reply");
    },
  };
  const command = createRaidCheckCommand({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    User,
    isRaidLeader: () => false,
    RAID_REQUIREMENT_MAP: {},
  });

  await command.handleRaidCheckButton(interaction);

  assert.deepEqual(events, ["defer", "language", "edit"]);
});

test("raid-check keeps Sync-check all and Refresh roster in every view within Discord limits, a user filter included", async () => {
  clearUserLanguageCache();
  const { createAllModeHandler } = require("../bot/handlers/raid-check/all-mode/all-mode");
  const { FILTER_ALL } = require("../bot/handlers/raid-check/all-mode/all-mode-filters");
  const handlers = {};
  const edits = [];
  const userDoc = {
    discordId: "roster-user", discordDisplayName: "Roster user", autoManageEnabled: true,
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki", itemLevel: 1740 }] }],
  };
  const User = {
    find: () => ({ select() { return this; }, lean: async () => [userDoc] }),
    findOne: () => ({ lean: async () => ({ language: "en" }) }),
  };
  const command = createAllModeHandler({
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
    User, ensureFreshWeek: () => {}, truncateText: text => String(text),
    buildAccountPageEmbed: () => new EmbedBuilder().setTitle("Roster"),
    buildStatusFooterText: () => "Weekly progress",
    summarizeRaidProgress: raids => ({ completed: 0, total: raids.length }),
    getStatusRaidsForCharacter: () => [{ raidKey: "act4", modeKey: "hard", goldReceives: true, isCompleted: false }],
    buildPaginationRow: (_page, _total, disabled) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("raid-check-all-page:prev").setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId("raid-check-all-page:next").setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
    isRaidLeader: () => true, RAID_CHECK_USER_QUERY_FIELDS: "", RAID_CHECK_PAGINATION_SESSION_MS: 1000,
  });
  const message = {
    createMessageComponentCollector: () => ({ on: (event, handler) => { handlers[event] = handler; } }),
    edit: async payload => { edits.push(payload); },
  };
  await command.handleRaidCheckAllCommand({
    user: { id: "ui-manager" }, guildId: "guild",
    deferReply: async () => {},
    editReply: async payload => { edits.push(payload); return message; },
  });
  const assertRows = () => {
    const rows = edits.at(-1).components.map(row => row.toJSON());
    assert.ok(rows.length <= 5);
    assert.ok(rows.every(row => row.components.length <= 5));
    const ids = rows.flatMap(row => row.components).map(item => item.custom_id);
    assert.ok(ids.includes("raid-check:sync-all"));
    assert.ok(ids.includes("raid-check-all:roster-refresh"));
    return rows;
  };
  assertRows();
  // The user filter adds the roster dropdown and, with auto-sync on, the
  // disable toggle: the fullest button row there is.
  for (const value of ["roster-user", FILTER_ALL]) {
    await handlers.collect({
      customId: "raid-check-all-filter:user", user: { id: "ui-manager" }, values: [value],
      update: async payload => { edits.push(payload); },
    });
    assertRows();
  }
  await handlers.end();
  assert.ok(assertRows().flatMap(row => row.components).every(item => item.disabled));
});

test("manager Sync-check all dispatches without requiring per-raid metadata", async () => {
  clearUserLanguageCache();
  let queries = 0;
  let report;
  const command = createRaidCheckCommand({
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
    User: {
      find: () => { queries += 1; return { select() { return this; }, lean: async () => [] }; },
      findOne: () => ({ lean: async () => ({ language: "en" }) }),
    },
    isRaidLeader: () => true, RAID_REQUIREMENT_MAP: {},
  });
  await command.handleRaidCheckButton({
    customId: "raid-check:sync-all", user: { id: "empty-sync-manager" },
    deferReply: async () => {}, editReply: async payload => { report = payload; },
  });
  assert.equal(queries, 1);
  assert.match(report.embeds[0].toJSON().description, /No rosters have Auto-sync enabled/);
});
