"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addAllModeActionButtons,
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
  currentView = "raid",
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
    currentView,
    currentViewUserId: "user-a",
    actionUserId,
    autoManageStateByDiscordId: new Map([["user-a", autoManageEnabled]]),
    localSyncStateByDiscordId: new Map([["user-a", localSyncEnabled]]),
  });
  return row.components.map((component) => component.data.customId);
}

test("raid-check all-mode buttons add edit, enable-auto, and task view in raid view", () => {
  assert.deepEqual(addButtons({ autoManageEnabled: false }), [
    "raid-check:edit-all:user-a",
    "raid-check:enable-auto-one:user-a",
    "raid-check-all:view-toggle:task",
  ]);
});

test("raid-check all-mode buttons add disable-auto when auto sync is on", () => {
  assert.deepEqual(addButtons({ autoManageEnabled: true }), [
    "raid-check:edit-all:user-a",
    "raid-check:disable-auto-one:user-a",
    "raid-check-all:view-toggle:task",
  ]);
});

test("raid-check all-mode buttons hide manager auto toggle for local-sync users", () => {
  assert.deepEqual(
    addButtons({ autoManageEnabled: false, localSyncEnabled: true }),
    ["raid-check:edit-all:user-a", "raid-check-all:view-toggle:task"]
  );
});

test("raid-check all-mode buttons only add back-to-raid toggle in task view", () => {
  assert.deepEqual(addButtons({ currentView: "task" }), [
    "raid-check-all:view-toggle:raid",
  ]);
});
