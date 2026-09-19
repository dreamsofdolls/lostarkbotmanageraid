"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addAllModeActionButtons,
  buildRosterRefreshButton,
  buildSyncAllButton,
} = require("../bot/handlers/raid-check/all-mode/all-mode-buttons");

class FakeButtonBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  setLabel(label) {
    this.data.label = label;
    return this;
  }

  setEmoji(emoji) {
    this.data.emoji = emoji;
    return this;
  }

  setStyle(style) {
    this.data.style = style;
    return this;
  }

  setDisabled(disabled) {
    this.data.disabled = disabled;
    return this;
  }
}

function createRow() {
  return {
    components: [],
    addComponents(...components) {
      this.components.push(...components);
      return this;
    },
  };
}

const ButtonStyle = {
  Primary: "primary",
  Secondary: "secondary",
};

const t = (key) => key;

function addButtons({
  currentViewUserId = "user-a",
  actionUserId = "user-a",
  autoManageEnabled = false,
  localSyncEnabled = false,
} = {}) {
  const row = createRow();
  addAllModeActionButtons({
    row,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    t,
    lang: "en",
    disabled: false,
    currentViewUserId,
    actionUserId,
    autoManageStateByDiscordId: new Map([["user-a", autoManageEnabled]]),
    localSyncStateByDiscordId: new Map([["user-a", localSyncEnabled]]),
  });
  return row.components.map((component) => component.data.customId);
}

test("raid-check all-mode buttons add enable-auto for the user on the page", () => {
  assert.deepEqual(addButtons({ autoManageEnabled: false }), [
    "raid-check:enable-auto-one:user-a",
  ]);
});

test("raid-check all-mode buttons add disable-auto when auto sync is on", () => {
  assert.deepEqual(addButtons({ autoManageEnabled: true }), [
    "raid-check:disable-auto-one:user-a",
  ]);
});

test("raid-check all-mode buttons hide manager auto toggle for local-sync users", () => {
  assert.deepEqual(addButtons({ autoManageEnabled: false, localSyncEnabled: true }), []);
});

test("raid-check all-mode buttons omit page actions when filters have no roster page", () => {
  assert.deepEqual(addButtons({ currentViewUserId: "", autoManageEnabled: false }), []);
});

test("raid-check all-mode roster refresh button uses all-mode collector id", () => {
  const button = buildRosterRefreshButton({
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    t,
    lang: "en",
    disabled: false,
  });

  assert.equal(button.data.customId, "raid-check-all:roster-refresh");
  assert.equal(button.data.disabled, false);
});

test("sync all button uses the manager-gated route and disables on session expiry", () => {
  for (const disabled of [false, true]) {
    const button = buildSyncAllButton({
      ButtonBuilder: FakeButtonBuilder, ButtonStyle, t, lang: "en", disabled,
    });
    assert.equal(button.data.customId, "raid-check:sync-all");
    assert.equal(button.data.label, "raid-check.buttons.syncAll");
    assert.equal(button.data.disabled, disabled);
  }
});
