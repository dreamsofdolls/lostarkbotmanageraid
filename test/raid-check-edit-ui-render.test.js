"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidCheckEditRenderer,
} = require("../bot/handlers/raid-check/edit-ui/render");

class FakeEmbedBuilder {
  constructor() {
    this.data = { fields: [] };
  }

  setTitle(title) {
    this.data.title = title;
    return this;
  }

  setColor(color) {
    this.data.color = color;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  addFields(...fields) {
    this.data.fields.push(...fields);
    return this;
  }

  setFooter(footer) {
    this.data.footer = footer;
    return this;
  }
}

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }

  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

class FakeStringSelectMenuBuilder {
  constructor() {
    this.data = { options: [] };
  }

  setCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  setPlaceholder(placeholder) {
    this.data.placeholder = placeholder;
    return this;
  }

  setDisabled(disabled) {
    this.data.disabled = disabled;
    return this;
  }

  addOptions(options) {
    this.data.options.push(...options);
    return this;
  }
}

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

const ButtonStyle = {
  Success: "success",
  Primary: "primary",
  Danger: "danger",
  Secondary: "secondary",
};

const UI = {
  colors: {
    neutral: 0x111111,
    success: 0x22aa66,
  },
  icons: {
    info: "[info]",
    warn: "[warn]",
  },
};

const RAID_REQUIREMENT_MAP = {
  kazer_hard: {
    raidKey: "kazer",
    modeKey: "hard",
    minItemLevel: 1730,
  },
  act4_normal: {
    raidKey: "act4",
    modeKey: "normal",
    minItemLevel: 1700,
  },
};

function createRenderer({ gateStatus } = {}) {
  return createRaidCheckEditRenderer({
    EmbedBuilder: FakeEmbedBuilder,
    StringSelectMenuBuilder: FakeStringSelectMenuBuilder,
    ActionRowBuilder: FakeActionRowBuilder,
    ButtonBuilder: FakeButtonBuilder,
    ButtonStyle,
    UI,
    truncateText: (value) => value,
    RAID_REQUIREMENT_MAP,
    getCharRaidGateStatus: () =>
      gateStatus || {
        overallStatus: "process",
        modeChangeNeeded: false,
        gates: [
          { gate: "G1", doneAtPickedMode: false, doneAtSomeMode: false },
          { gate: "G2", doneAtPickedMode: false, doneAtSomeMode: false },
        ],
      },
    formatGateStateLine: (status) =>
      status ? status.gates.map((gate) => gate.gate).join(" / ") : "",
    formatCharEditLabel: (char) => `${char.charName} ${char.itemLevel}`,
    formatUserEditLabel: (_group, displayName) => displayName,
    RAID_CHECK_EDIT_SESSION_MS: 10 * 60_000,
  });
}

function createState(overrides = {}) {
  return {
    lang: "en",
    applied: false,
    locked: false,
    scopeAll: false,
    raidMeta: RAID_REQUIREMENT_MAP.act4_normal,
    editableByUser: new Map(),
    displayMap: new Map(),
    selectedRaid: "act4_normal",
    selectedUser: null,
    selectedChar: null,
    awaitingGate: false,
    warning: null,
    message: null,
    ...overrides,
  };
}

test("raid-check edit renderer shows only raid picker before scope-all raid selection", () => {
  const { buildEditComponents } = createRenderer();

  const rows = buildEditComponents(
    createState({
      scopeAll: true,
      raidMeta: null,
      selectedRaid: null,
    })
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].components[0].data.customId, "raid-check-edit:raid");
  assert.deepEqual(
    rows[0].components[0].data.options.map((option) => option.value),
    ["act4_normal", "kazer_hard"]
  );
});

test("raid-check edit renderer builds user, char, status, and gate rows from state", () => {
  const { buildEditComponents } = createRenderer({
    gateStatus: {
      overallStatus: "process",
      modeChangeNeeded: true,
      gates: [
        { gate: "G1", doneAtPickedMode: true, doneAtSomeMode: true },
        { gate: "G2", doneAtPickedMode: false, doneAtSomeMode: true },
        { gate: "G3", doneAtPickedMode: false, doneAtSomeMode: false },
      ],
    },
  });
  const state = createState({
    editableByUser: new Map([
      [
        "100",
        {
          discordId: "100",
          autoManageEnabled: true,
          chars: [
            {
              accountName: "Main",
              charName: "Qiylyn",
              itemLevel: 1700,
              publicLogDisabled: true,
            },
          ],
        },
      ],
    ]),
    displayMap: new Map([["100", "Traine"]]),
    selectedUser: "100",
    selectedChar: {
      accountName: "Main",
      charName: "Qiylyn",
      itemLevel: 1700,
      publicLogDisabled: true,
    },
    awaitingGate: true,
  });

  const rows = buildEditComponents(state);

  assert.equal(rows.length, 4);
  assert.equal(rows[0].components[0].data.customId, "raid-check-edit:user");
  assert.equal(rows[1].components[0].data.customId, "raid-check-edit:char");

  const statusButtons = rows[2].components.map((component) => component.data);
  assert.deepEqual(
    statusButtons.map((button) => button.customId),
    [
      "raid-check-edit:status:complete",
      "raid-check-edit:status:process",
      "raid-check-edit:status:reset",
      "raid-check-edit:cancel",
    ]
  );
  assert.equal(statusButtons[0].disabled, false);
  assert.equal(statusButtons[1].disabled, false);

  const gateButtons = rows[3].components.map((component) => component.data);
  assert.deepEqual(
    gateButtons.map((button) => [button.customId, button.disabled, button.style]),
    [
      ["raid-check-edit:gate:G1", true, ButtonStyle.Secondary],
      ["raid-check-edit:gate:G2", false, ButtonStyle.Primary],
      ["raid-check-edit:gate:G3", false, ButtonStyle.Primary],
    ]
  );
});

test("raid-check edit renderer adds warning/result fields without coupling to the handler", () => {
  const { buildEditEmbed } = createRenderer();

  const warningEmbed = buildEditEmbed(
    createState({
      warning: "Pick a gate",
    })
  );
  assert.equal(warningEmbed.data.color, UI.colors.neutral);
  assert.equal(warningEmbed.data.fields.length, 1);
  assert.match(warningEmbed.data.fields[0].value, /Pick a gate/);

  const resultEmbed = buildEditEmbed(
    createState({
      applied: true,
      message: "Done",
    })
  );
  assert.equal(resultEmbed.data.color, UI.colors.success);
  assert.equal(resultEmbed.data.fields.length, 1);
  assert.match(resultEmbed.data.fields[0].value, /Done/);
});
