const test = require("node:test");
const assert = require("node:assert/strict");

const {
  handleRosterPickerToggle,
  loadRosterPickerButtonContext,
  selectedRosterPickerChars,
} = require("../bot/handlers/roster/button-flow");

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

test("roster picker toggle updates valid indexes and defers stale indexes", async () => {
  const session = {
    sessionId: "sess",
    chars: [{ charName: "A" }, { charName: "B" }],
    selectedIndices: new Set([0]),
  };
  const interaction = makeInteraction("add-roster:toggle:sess:1");

  await handleRosterPickerToggle({
    interaction,
    session,
    charIndex: 1,
    buildSelectionEmbed: (s) => ({ selected: [...s.selectedIndices] }),
    buildSelectionComponents: () => ["components"],
  });

  assert.deepEqual([...session.selectedIndices].sort(), [0, 1]);
  assert.equal(interaction.updates.length, 1);

  await handleRosterPickerToggle({
    interaction,
    session,
    charIndex: 99,
    buildSelectionEmbed: () => ({}),
    buildSelectionComponents: () => [],
  });

  assert.equal(interaction.deferred, 1);
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
