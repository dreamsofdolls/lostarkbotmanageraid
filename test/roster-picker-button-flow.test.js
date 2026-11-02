const test = require("node:test");
const assert = require("node:assert/strict");

const {
  flipRosterPickerIndices,
  handleRosterPickerNavigationAction,
  loadRosterPickerButtonContext,
  selectedRosterPickerChars,
} = require("../bot/handlers/roster/picker/button-flow");
const { buildFlipPickerComponents } = require("../bot/utils/raid/roster-picker");

function makeInteraction(customId, userId = "user-1") {
  return {
    customId,
    user: { id: userId },
    replies: [],
    updates: [],
    deferred: 0,
    async reply(payload) {
      this.replies.push(payload);
    },
    async update(payload) {
      this.updates.push(payload);
    },
    async deferUpdate() {
      this.deferred += 1;
    },
  };
}

test("roster picker button context replies to stale sessions", async () => {
  const interaction = makeInteraction("add-roster:confirm:missing");

  const context = await loadRosterPickerButtonContext({
    interaction,
    prefix: "add-roster",
    sessions: new Map(),
    User: {},
    getUserLanguage: async () => "vi",
    buildNoticeEmbed: (EmbedBuilder, data) => data,
    EmbedBuilder: class {},
    MessageFlags: { Ephemeral: 64 },
    t: (key) => key,
    staleTitleKey: "stale.title",
    staleDescriptionKey: "stale.description",
    authTitleKey: "auth.title",
    authDescriptionKey: "auth.description",
  });

  assert.equal(context.handled, true);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].flags, 64);
  assert.equal(interaction.replies[0].embeds[0].title, "stale.title");
});

test("roster picker navigation routes toggles and defers stale indexes", async () => {
  const session = {
    sessionId: "sess",
    chars: [{ charName: "A" }, { charName: "B" }],
    selectedIndices: new Set([0]),
  };
  const interaction = makeInteraction("add-roster:toggle:sess:1");

  const handled = await handleRosterPickerNavigationAction({
    interaction,
    context: {
      action: "toggle",
      route: { index: 1 },
      sessionId: "sess",
      session,
    },
    sessions: new Map([["sess", session]]),
    buildSelectionEmbed: (s) => ({ selected: [...s.selectedIndices] }),
    buildSelectionComponents: () => ["components"],
    buildCancelledEmbed: () => ({}),
  });

  assert.equal(handled, true);
  assert.deepEqual([...session.selectedIndices].sort(), [0, 1]);
  assert.equal(interaction.updates.length, 1);

  await handleRosterPickerNavigationAction({
    interaction,
    context: {
      action: "toggle",
      route: { index: 99 },
      sessionId: "sess",
      session,
    },
    sessions: new Map([["sess", session]]),
    buildSelectionEmbed: () => ({}),
    buildSelectionComponents: () => [],
    buildCancelledEmbed: () => ({}),
  });

  assert.equal(interaction.deferred, 1);
});

test("roster picker navigation clears cancelled sessions and ignores confirm", async () => {
  const session = {
    sessionId: "sess",
    chars: [],
    selectedIndices: new Set(),
    expireTimer: null,
  };
  const sessions = new Map([["sess", session]]);
  const interaction = makeInteraction("add-roster:cancel:sess");

  const cancelled = await handleRosterPickerNavigationAction({
    interaction,
    context: { action: "cancel", route: {}, sessionId: "sess", session },
    sessions,
    buildSelectionEmbed: () => ({}),
    buildSelectionComponents: () => [],
    buildCancelledEmbed: () => ({ cancelled: true }),
  });

  assert.equal(cancelled, true);
  assert.equal(sessions.has("sess"), false);
  assert.deepEqual(interaction.updates[0], {
    embeds: [{ cancelled: true }],
    components: [],
  });

  const confirmed = await handleRosterPickerNavigationAction({
    interaction,
    context: { action: "confirm", route: {}, sessionId: "sess", session },
    sessions,
    buildSelectionEmbed: () => ({}),
    buildSelectionComponents: () => [],
    buildCancelledEmbed: () => ({}),
  });
  assert.equal(confirmed, false);
});

test("selectedRosterPickerChars returns chars sorted by picker index", () => {
  const session = {
    chars: [{ charName: "A" }, { charName: "B" }, { charName: "C" }],
    selectedIndices: new Set([2, 0]),
  };
  assert.deepEqual(
    selectedRosterPickerChars(session).map((c) => c.charName),
    ["A", "C"],
  );
});

test("flipRosterPickerIndices flips unique in-range indexes only", () => {
  const session = {
    chars: [{ charName: "A" }, { charName: "B" }, { charName: "C" }],
    selectedIndices: new Set([0]),
  };

  assert.equal(flipRosterPickerIndices(session, ["1", "1", "0", "7", "x"]), true);
  assert.deepEqual([...session.selectedIndices], [1]);

  assert.equal(flipRosterPickerIndices(session, ["9"]), false);
  assert.deepEqual([...session.selectedIndices], [1]);
});

test("roster picker navigation flips picks and redraws", async () => {
  const session = {
    sessionId: "sess",
    chars: [{ charName: "A" }, { charName: "B" }],
    selectedIndices: new Set([1]),
  };
  const interaction = makeInteraction("add-roster:pick:sess");
  interaction.values = ["0"];

  const handled = await handleRosterPickerNavigationAction({
    interaction,
    context: { action: "pick", sessionId: "sess", session },
    sessions: new Map([["sess", session]]),
    buildSelectionEmbed: (s) => ({ selected: [...s.selectedIndices].sort() }),
    buildSelectionComponents: () => ["components"],
    buildCancelledEmbed: () => ({}),
  });

  assert.equal(handled, true);
  assert.deepEqual([...session.selectedIndices].sort(), [0, 1]);
  assert.deepEqual(interaction.updates, [{ embeds: [{ selected: [0, 1] }], components: ["components"] }]);
});

test("buildFlipPickerComponents builds a placeholder select with no defaults", () => {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
  const session = {
    sessionId: "sess",
    chars: [{ charName: "A" }, { charName: "B" }],
    selectedIndices: new Set([0]),
  };

  const rows = buildFlipPickerComponents({
    session,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    customIdPrefix: "add-roster",
    placeholder: "Pick to flip",
    describeOption: (character, index) => ({ label: `${index + 1}. ${character.charName}`, description: "state" }),
    confirmLabel: "Save (1)",
    confirmDisabled: false,
    cancelLabel: "Cancel",
  }).map((row) => row.toJSON());

  const select = rows[0].components[0];
  assert.equal(select.custom_id, "add-roster:pick:sess");
  assert.equal(select.placeholder, "Pick to flip");
  assert.equal(select.min_values, 1);
  assert.equal(select.max_values, 2);
  assert.deepEqual(select.options.map((option) => option.value), ["0", "1"]);
  assert.equal(select.options.some((option) => option.default === true), false);
  assert.deepEqual(rows[1].components.map((button) => button.custom_id), [
    "add-roster:confirm:sess",
    "add-roster:cancel:sess",
  ]);
});
