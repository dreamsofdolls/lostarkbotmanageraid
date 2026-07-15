"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

const {
  createRaidStatusComponentLayout,
} = require("../bot/handlers/raid-status/components/component-layout");
const {
  attachRaidStatusComponentCollector,
} = require("../bot/handlers/raid-status/components/component-collector");
const {
  createRaidStatusSyncControls,
} = require("../bot/handlers/raid-status/sync/sync-controls");

function makeButton(customId) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(customId)
    .setStyle(ButtonStyle.Secondary);
}

function componentCustomId(component) {
  return component?.data?.custom_id || component?.data?.customId || "";
}

function buildControls(getStatusUserMeta) {
  return createRaidStatusSyncControls({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    User: {},
    discordId: "viewer",
    lang: "en",
    formatNextCooldownRemaining: () => "",
    getAutoManageCooldownMs: () => 0,
    AUTO_MANAGE_SYNC_COOLDOWN_MS: 0,
    getStatusUserMeta,
  });
}

test("raid-status exposes the interaction-only Solo Companion launcher only in Auto-sync mode", () => {
  let statusUserMeta = { autoManageEnabled: true, localSyncEnabled: false };
  const controls = buildControls(() => statusUserMeta);

  const autoButton = controls.buildSoloCompanionButton(false);
  assert.equal(componentCustomId(autoButton), "status:solo-companion");
  assert.equal(autoButton.data.style, ButtonStyle.Secondary);
  assert.equal(autoButton.data.url, undefined, "the public launcher must not carry a token URL");

  statusUserMeta = { autoManageEnabled: false, localSyncEnabled: false };
  assert.equal(controls.buildSoloCompanionButton(false), null);

  statusUserMeta = { autoManageEnabled: true, localSyncEnabled: true };
  assert.equal(controls.buildSoloCompanionButton(false), null);
});

test("raid-status hides Solo Companion on shared pages and keeps every Discord row within limits", () => {
  let accounts = [{ accountName: "Own roster" }];
  const statusUserMeta = { autoManageEnabled: true, localSyncEnabled: false };
  const controls = buildControls(() => statusUserMeta);
  const buildLayout = () => createRaidStatusComponentLayout({
    ActionRowBuilder,
    StringSelectMenuBuilder,
    truncateText: (value) => String(value),
    lang: "en",
    buildPaginationRow: () => new ActionRowBuilder()
      .addComponents(makeButton("status:prev"), makeButton("status:next")),
    buildViewToggleRow: () => new ActionRowBuilder().addComponents(makeButton("status-view:toggle")),
    buildSyncButton: controls.buildSyncButton,
    buildSyncRow: controls.buildSyncRow,
    buildLocalSyncNewButton: controls.buildLocalSyncNewButton,
    buildLocalSyncRefreshButton: controls.buildLocalSyncRefreshButton,
    buildRosterRefreshButton: controls.buildRosterRefreshButton,
    buildSoloCompanionButton: controls.buildSoloCompanionButton,
    buildRaidFilterRow: () => null,
    buildStatusRosterFilterRow: () => null,
    buildMyRaidsRow: () => null,
    getAccounts: () => accounts,
    getCurrentPage: () => 0,
    getCurrentLocalPage: () => 0,
    getVisibleRosterCount: () => 1,
    getCurrentView: () => "raid",
    getStatusUserMeta: () => statusUserMeta,
    getRaidDropdownEntries: () => [],
    getTotalRaidPending: () => 0,
    getFilterRaidId: () => null,
    getRosterFilterEntries: () => [],
    getSelectedRosterIndex: () => null,
    getMyRaidsShaped: () => [],
  });

  const ownRows = buildLayout().buildComponents(false);
  const ownIds = ownRows.flatMap((row) => row.components.map(componentCustomId));
  assert.ok(ownIds.includes("status:sync"));
  assert.ok(ownIds.includes("status:solo-companion"));
  assert.ok(ownRows.length <= 5);
  assert.ok(ownRows.every((row) => row.components.length <= 5));

  accounts = [{
    accountName: "Shared roster",
    _sharedFrom: { ownerDiscordId: "owner", accessLevel: "view" },
  }];
  const sharedRows = buildLayout().buildComponents(false);
  const sharedIds = sharedRows.flatMap((row) => row.components.map(componentCustomId));
  assert.equal(sharedIds.includes("status:sync"), false);
  assert.equal(sharedIds.includes("status:solo-companion"), false);
  assert.ok(sharedRows.length <= 5);
  assert.ok(sharedRows.every((row) => row.components.length <= 5));
});

test("raid-status collector rejects another user's Solo Companion click before dispatch", async () => {
  const listeners = new Map();
  const collector = {
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
  };
  let handlerCalls = 0;
  const ackOrder = [];
  let replyPayload = null;

  attachRaidStatusComponentCollector({
    EmbedBuilder,
    User: {
      findOne() {
        return {
          lean: async () => ({ language: "en" }),
        };
      },
    },
    interaction: {
      user: { id: "owner" },
      editReply: async () => {},
    },
    message: {
      createMessageComponentCollector() {
        return collector;
      },
    },
    lang: "en",
    sessionMs: 60_000,
    taskAutoRefreshGraceMs: 100,
    getAccounts: () => [],
    getCurrentPage: () => 0,
    getCurrentView: () => "raid",
    buildCurrentEmbed: () => new EmbedBuilder(),
    buildEmbedAndCanvas: async () => ({}),
    buildComponents: () => [],
    componentRouteHandlers: {
      soloCompanion: async () => {
        handlerCalls += 1;
      },
    },
  });

  await listeners.get("collect")({
    customId: "status:solo-companion",
    user: { id: "intruder" },
    async deferReply(payload) {
      ackOrder.push(["defer", payload]);
    },
    async editReply(payload) {
      ackOrder.push(["edit", payload]);
      replyPayload = payload;
    },
  });

  assert.equal(handlerCalls, 0);
  assert.equal(ackOrder[0][0], "defer");
  assert.equal(ackOrder[0][1].flags, 64);
  assert.equal(ackOrder[1][0], "edit");
  assert.match(replyPayload.embeds[0].data.title, /only the command author/i);
});
