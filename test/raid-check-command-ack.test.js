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

test("raid-check opens on rosters with a character from 1720 and skips the rest", async () => {
  clearUserLanguageCache();
  const { createAllModeHandler } = require("../bot/handlers/raid-check/all-mode/all-mode");
  const handlers = {};
  const renderedRosters = [];
  const pageTotals = [];
  const userDoc = {
    discordId: "roster-user", discordDisplayName: "Roster user",
    accounts: [
      { accountName: "Alts", characters: [{ name: "Low", itemLevel: 1710 }] },
      { accountName: "Main", characters: [{ name: "Aki", itemLevel: 1740 }] },
    ],
  };
  const User = {
    find: () => ({ select() { return this; }, lean: async () => [userDoc] }),
    findOne: () => ({ lean: async () => ({ language: "en" }) }),
  };
  const command = createAllModeHandler({
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
    User, ensureFreshWeek: () => {}, truncateText: text => String(text),
    buildAccountPageEmbed: (account) => {
      renderedRosters.push(account.accountName);
      return new EmbedBuilder().setTitle(account.accountName);
    },
    buildStatusFooterText: () => "Weekly progress",
    summarizeRaidProgress: raids => ({ completed: 0, total: raids.length }),
    getStatusRaidsForCharacter: () => [{ raidKey: "act4", modeKey: "hard", goldReceives: true, isCompleted: false }],
    buildPaginationRow: (_page, total, disabled) => {
      pageTotals.push(total);
      return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("raid-check-all-page:prev").setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      );
    },
    isRaidLeader: () => true, RAID_CHECK_USER_QUERY_FIELDS: "", RAID_CHECK_PAGINATION_SESSION_MS: 1000,
  });
  const message = {
    createMessageComponentCollector: () => ({ on: (event, handler) => { handlers[event] = handler; } }),
    edit: async () => {},
  };
  await command.handleRaidCheckAllCommand({
    user: { id: "ui-manager" }, guildId: "guild",
    deferReply: async () => {},
    editReply: async () => message,
  });

  assert.deepEqual(renderedRosters, ["Main"]);
  assert.equal(pageTotals.at(-1), 1);
  await handlers.end();
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

async function openAllModeSession({
  userDoc,
  userDocs = [userDoc],
  runManualRosterRefresh,
  getStatusRaidsForCharacter = () => [{ raidKey: "act4", modeKey: "hard", goldReceives: true, isCompleted: false }],
  buildAccountPageEmbed = () => new EmbedBuilder().setTitle("Roster"),
  refreshServices,
} = {}) {
  clearUserLanguageCache();
  const { createAllModeHandler } = require("../bot/handlers/raid-check/all-mode/all-mode");
  const handlers = {};
  const edits = [];
  const User = {
    find: () => ({ select() { return this; }, lean: async () => userDocs }),
    findOne: () => ({ lean: async () => ({ language: "en" }) }),
  };
  const command = createAllModeHandler({
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
    User, ensureFreshWeek: () => {}, truncateText: text => String(text),
    buildAccountPageEmbed,
    buildStatusFooterText: () => "Weekly progress",
    summarizeRaidProgress: raids => ({ completed: 0, total: raids.length }),
    getStatusRaidsForCharacter,
    buildPaginationRow: (_page, _total, disabled) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("raid-check-all-page:prev").setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
    isRaidLeader: () => true, RAID_CHECK_USER_QUERY_FIELDS: "", RAID_CHECK_PAGINATION_SESSION_MS: 1000,
    runManualRosterRefresh,
    ...refreshServices,
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
  return { handlers, edits };
}

const lastEditComponents = edits => edits.at(-1).components.flatMap(row => row.toJSON().components);

test("a rejected Discord call in the raid-check collector is logged instead of crashing the bot", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => { errors.push(args); });
  const { handlers } = await openAllModeSession({
    userDoc: {
      discordId: "roster-user", discordDisplayName: "Roster user",
      accounts: [{ accountName: "Roster", characters: [{ name: "Aki", itemLevel: 1740 }] }],
    },
  });
  const unknownInteraction = Object.assign(new Error("Unknown interaction"), { code: 10062 });

  // An unhandled rejection here would reach process-lifecycle and exit the bot.
  await handlers.collect({
    customId: "raid-check-all-teams:0", user: { id: "ui-manager" }, values: ["event-1"],
    deferReply: async () => { throw unknownInteraction; },
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].at(-1), unknownInteraction);
  await handlers.end();
});

test("raid-check roster refresh that outlives the session leaves the controls disabled", async () => {
  const userDoc = {
    discordId: "roster-user", discordDisplayName: "Roster user",
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki", itemLevel: 1740 }] }],
  };
  const session = await openAllModeSession({
    userDoc,
    runManualRosterRefresh: async () => {
      // The 5-minute collector ends while Bible is still answering.
      await session.handlers.end();
      return { status: "updated", accountName: "Roster", userDoc: { ...userDoc } };
    },
  });

  await session.handlers.collect({
    customId: "raid-check-all:roster-refresh", user: { id: "ui-manager" },
    deferUpdate: async () => {}, followUp: async () => {},
  });

  assert.ok(lastEditComponents(session.edits).every(item => item.disabled));
});

test("raid-check auto-sync button follows the flag of a refreshed roster", async () => {
  const userDoc = {
    discordId: "roster-user", discordDisplayName: "Roster user", autoManageEnabled: true,
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki", itemLevel: 1740 }] }],
  };
  const { handlers, edits } = await openAllModeSession({
    userDoc,
    // The manager turned auto-sync off with this view's own button earlier.
    runManualRosterRefresh: async () => ({
      status: "updated", accountName: "Roster", userDoc: { ...userDoc, autoManageEnabled: false },
    }),
  });
  const buttonIds = () => lastEditComponents(edits).map(item => item.custom_id);
  assert.ok(buttonIds().includes("raid-check:disable-auto-one:roster-user"));

  await handlers.collect({
    customId: "raid-check-all:roster-refresh", user: { id: "ui-manager" },
    deferUpdate: async () => {}, followUp: async () => {},
  });

  assert.ok(buttonIds().includes("raid-check:enable-auto-one:roster-user"));
  assert.ok(!buttonIds().includes("raid-check:disable-auto-one:roster-user"));
  await handlers.end();
});

const rosterDocFor = discordId => ({
  discordId, discordDisplayName: discordId,
  accounts: [{ accountName: `${discordId}-roster`, characters: [{ name: `${discordId}-char`, itemLevel: 1740 }] }],
});

test("a manual roster refresh of one user re-derives only that user's characters", async () => {
  const docs = [rosterDocFor("user-a"), rosterDocFor("user-b")];
  let derivations = 0;
  const { handlers } = await openAllModeSession({
    userDocs: docs,
    getStatusRaidsForCharacter: () => {
      derivations += 1;
      return [{ raidKey: "act4", modeKey: "hard", goldReceives: true, isCompleted: false }];
    },
    runManualRosterRefresh: async discordId => ({
      status: "updated", accountName: `${discordId}-roster`,
      userDoc: structuredClone(docs.find(doc => doc.discordId === discordId)),
    }),
  });
  const afterOpen = derivations;

  await handlers.collect({
    customId: "raid-check-all:roster-refresh", user: { id: "ui-manager" },
    deferUpdate: async () => {}, followUp: async () => {},
  });

  assert.equal(derivations - afterOpen, 1);
  await handlers.end();
});

test("a background refresh of one user re-derives only that user's characters", async () => {
  const docs = [rosterDocFor("user-a"), rosterDocFor("user-b")];
  let derivations = 0;
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  const { handlers } = await openAllModeSession({
    userDocs: docs,
    getStatusRaidsForCharacter: () => {
      derivations += 1;
      return [{ raidKey: "act4", modeKey: "hard", goldReceives: true, isCompleted: false }];
    },
    refreshServices: {
      raidCheckRefreshLimiter: { run: job => job() },
      shouldLoadFreshUserSnapshotForRaidViews: doc => doc.discordId === "user-a",
      loadFreshUserSnapshotForRaidViews: async doc => {
        await refreshGate;
        return structuredClone(doc);
      },
    },
  });
  const afterOpen = derivations;

  releaseRefresh();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(derivations - afterOpen, 1);
  await handlers.end();
});

const multiRosterDoc = (discordId, accountNames) => ({
  discordId, discordDisplayName: discordId,
  accounts: accountNames.map(accountName => ({
    accountName, characters: [{ name: `${accountName}-char`, itemLevel: 1740 }],
  })),
});

// Only the user of `refreshedDoc` is stale; its background refresh lands when `settleRefresh` runs.
async function openSessionWithGatedRefresh({ userDocs, refreshedDoc }) {
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  const session = await openAllModeSession({
    userDocs,
    buildAccountPageEmbed: account => new EmbedBuilder().setTitle(account.accountName),
    refreshServices: {
      raidCheckRefreshLimiter: { run: job => job() },
      shouldLoadFreshUserSnapshotForRaidViews: doc => doc.discordId === refreshedDoc.discordId,
      loadFreshUserSnapshotForRaidViews: async () => {
        await refreshGate;
        return refreshedDoc;
      },
    },
  });
  const pick = (customId, value) => session.handlers.collect({
    customId, user: { id: "ui-manager" }, values: [value],
    update: async payload => { session.edits.push(payload); },
  });
  const settleRefresh = async () => {
    releaseRefresh();
    await new Promise(resolve => setImmediate(resolve));
  };
  const next = () => pick("raid-check-all-page:next");
  return { ...session, pick, next, settleRefresh };
}

const lastEmbedTitle = edits => edits.filter(edit => edit.embeds).at(-1).embeds[0].toJSON().title;
const userDropdownValues = edits =>
  lastEditComponents(edits).find(item => item.custom_id === "raid-check-all-filter:user").options.map(option => option.value);

test("a background refresh that drops a roster keeps the viewer on the roster selected under another user's filter", async () => {
  const { handlers, edits, pick, settleRefresh } = await openSessionWithGatedRefresh({
    userDocs: [multiRosterDoc("u1", ["Alpha", "Bravo"]), multiRosterDoc("u2", ["Cleo", "Dina", "Eve"])],
    refreshedDoc: multiRosterDoc("u1", ["Bravo"]),
  });
  await pick("raid-check-all-filter:user", "u2");
  await pick("raid-check-all-filter:roster", "3");
  assert.equal(lastEmbedTitle(edits), "Dina");

  await settleRefresh();

  assert.equal(lastEmbedTitle(edits), "Dina");
  // A later filter change recomputes the pages from the roster index the refresh remapped.
  await pick("raid-check-all-filter:status", "pending");
  assert.equal(lastEmbedTitle(edits), "Dina");
  await handlers.end();
});

test("a background refresh that drops an earlier roster keeps the unfiltered viewer on the same roster", async () => {
  const { handlers, edits, next, settleRefresh } = await openSessionWithGatedRefresh({
    userDocs: [multiRosterDoc("u1", ["Alpha", "Bravo"]), multiRosterDoc("u2", ["Cleo", "Dina", "Eve"])],
    refreshedDoc: multiRosterDoc("u1", ["Bravo"]),
  });
  await next();
  await next();
  assert.equal(lastEmbedTitle(edits), "Cleo");

  await settleRefresh();

  assert.equal(lastEmbedTitle(edits), "Cleo");
  await handlers.end();
});

test("a background refresh that drops the viewed roster leaves the viewer on the last valid page", async () => {
  const { handlers, edits, next, settleRefresh } = await openSessionWithGatedRefresh({
    userDocs: [multiRosterDoc("u1", ["Alpha", "Bravo"]), multiRosterDoc("u2", ["Cleo", "Dina", "Eve"])],
    refreshedDoc: multiRosterDoc("u2", ["Cleo"]),
  });
  for (let page = 0; page < 4; page += 1) await next();
  assert.equal(lastEmbedTitle(edits), "Eve");

  await settleRefresh();

  assert.equal(lastEmbedTitle(edits), "Cleo");
  await handlers.end();
});

test("a user whose every roster a refresh dropped leaves the user dropdown", async () => {
  const { handlers, edits, settleRefresh } = await openSessionWithGatedRefresh({
    userDocs: [multiRosterDoc("u1", ["Alpha"]), multiRosterDoc("u2", ["Cleo"])],
    refreshedDoc: multiRosterDoc("u1", []),
  });
  assert.deepEqual(userDropdownValues(edits).sort(), ["u1", "u2"]);

  await settleRefresh();

  assert.deepEqual(userDropdownValues(edits), ["u2"]);
  await handlers.end();
});

test("a user filter on a user whose every roster a refresh dropped is cleared", async () => {
  const { handlers, edits, pick, settleRefresh } = await openSessionWithGatedRefresh({
    userDocs: [multiRosterDoc("u1", ["Alpha"]), multiRosterDoc("u2", ["Cleo"])],
    refreshedDoc: multiRosterDoc("u1", []),
  });
  await pick("raid-check-all-filter:user", "u1");
  assert.equal(lastEmbedTitle(edits), "Alpha");

  await settleRefresh();

  assert.equal(lastEmbedTitle(edits), "Cleo");
  assert.ok(!lastEditComponents(edits).some(item => item.custom_id === "raid-check-all-filter:roster"));
  await handlers.end();
});

test("a refresh that leaves no roster in the session keeps the user dropdown populated", async () => {
  const { handlers, edits, settleRefresh } = await openSessionWithGatedRefresh({
    userDocs: [multiRosterDoc("u1", ["Alpha"])],
    refreshedDoc: multiRosterDoc("u1", []),
  });

  await settleRefresh();

  // Discord rejects a select menu without options.
  assert.deepEqual(userDropdownValues(edits), ["u1"]);
  await handlers.end();
});

test("raid-check disables its controls at session end through the interaction, not the ephemeral message", async () => {
  clearUserLanguageCache();
  const { createAllModeHandler } = require("../bot/handlers/raid-check/all-mode/all-mode");
  const handlers = {};
  const replies = [];
  const userDoc = {
    discordId: "roster-user", discordDisplayName: "Roster user", autoManageEnabled: false,
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
  // Discord serves an ephemeral reply only through the interaction webhook,
  // so the channel-route Message#edit fails.
  const message = {
    createMessageComponentCollector: () => ({ on: (event, handler) => { handlers[event] = handler; } }),
    edit: async () => { throw new Error("Unknown Message"); },
  };
  await command.handleRaidCheckAllCommand({
    user: { id: "ui-manager" }, guildId: "guild",
    deferReply: async () => {},
    editReply: async payload => { replies.push(payload); return message; },
  });

  await handlers.end();

  const rows = replies.at(-1).components.map(row => row.toJSON());
  assert.ok(rows.length > 0);
  assert.ok(rows.flatMap(row => row.components).every(item => item.disabled));
});
