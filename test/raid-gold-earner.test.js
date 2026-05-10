// Tests for /raid-gold-earner picker logic.
//
// Focus on the behavior that can drift without notice: pre-check
// fallback for legacy data, cap-6 enforcement at toggle time, and the
// off-window-preserve rule when a roster has more chars than the
// 20-char picker cap. Full Discord interaction lifecycle (defer/update/
// collector) is intentionally not exercised here - those paths live in
// the actual handler and are too coupled to the Discord.js client to
// usefully unit-test.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { UI } = require("../bot/utils/raid/common/shared");
const {
  createRaidGoldEarnerCommand,
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
} = require("../bot/handlers/roster/gold-earner");

function makeCommand({ User, saveWithRetry, loadUserForAutocomplete } = {}) {
  return createRaidGoldEarnerCommand({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    UI,
    User: User || {
      findOne: async () => null,
    },
    saveWithRetry: saveWithRetry || (async (op) => op()),
    loadUserForAutocomplete: loadUserForAutocomplete || (async () => null),
  });
}

// --------- pickInitialSelection ---------

test("pickInitialSelection: mirrors current isGoldEarner state when at least one char is already an earner", () => {
  const { __test } = makeCommand();
  const chars = [
    { itemLevel: 1745, isGoldEarner: false },
    { itemLevel: 1740, isGoldEarner: true }, // <- existing earner
    { itemLevel: 1735, isGoldEarner: false },
  ];
  const sel = __test.pickInitialSelection(chars);
  assert.deepEqual([...sel].sort(), [1]);
});

test("pickInitialSelection: pre-checks top 6 by iLvl when ALL chars are currently false (legacy migration UX)", () => {
  // Legacy data path: every char in the account explicitly false (saved
  // before the schema default flipped to true). Picker pre-checks the
  // 6 highest-iLvl chars so the user can Confirm in one click.
  const { __test } = makeCommand();
  const chars = [
    { itemLevel: 1745, isGoldEarner: false },
    { itemLevel: 1740, isGoldEarner: false },
    { itemLevel: 1735, isGoldEarner: false },
    { itemLevel: 1730, isGoldEarner: false },
    { itemLevel: 1720, isGoldEarner: false },
    { itemLevel: 1710, isGoldEarner: false },
    { itemLevel: 1700, isGoldEarner: false },
    { itemLevel: 1690, isGoldEarner: false },
  ];
  const sel = __test.pickInitialSelection(chars);
  assert.equal(sel.size, GOLD_EARNER_CAP_PER_ACCOUNT);
  // Top 6 by iLvl correspond to indices 0..5 in this fixture (already sorted desc).
  assert.deepEqual([...sel].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test("pickInitialSelection: pre-checks fewer than 6 when account has fewer than 6 chars total", () => {
  // 3-char roster, all currently false. Migration path should still
  // pre-check ALL of them (cap is a max, not a min).
  const { __test } = makeCommand();
  const chars = [
    { itemLevel: 1745, isGoldEarner: false },
    { itemLevel: 1730, isGoldEarner: false },
    { itemLevel: 1700, isGoldEarner: false },
  ];
  const sel = __test.pickInitialSelection(chars);
  assert.equal(sel.size, 3);
});

test("pickInitialSelection: respects an existing partial selection - no migration override", () => {
  // Even if only 2 of 8 chars are earners (below the 6 cap), the
  // helper does NOT auto-promote - the user has signaled intent and
  // the picker reflects that intent verbatim.
  const { __test } = makeCommand();
  const chars = [
    { itemLevel: 1745, isGoldEarner: true }, // 0
    { itemLevel: 1740, isGoldEarner: false }, // 1
    { itemLevel: 1735, isGoldEarner: false }, // 2
    { itemLevel: 1730, isGoldEarner: true }, // 3
    { itemLevel: 1700, isGoldEarner: false }, // 4
  ];
  const sel = __test.pickInitialSelection(chars);
  assert.deepEqual([...sel].sort((a, b) => a - b), [0, 3]);
});

// --------- exported constants ---------

test("constants: cap-6-per-account + 20-char picker cap match LA + Discord limits", () => {
  // Bake the magic numbers into the test so a future reduction of
  // either constant is visible at code review time, not surprising at
  // runtime.
  assert.equal(GOLD_EARNER_CAP_PER_ACCOUNT, 6);
  assert.equal(PICKER_MAX_OPTIONS, 20);
});

// --------- handleRaidGoldEarnerCommand happy path ---------

test("handleRaidGoldEarnerCommand: opens picker with session keyed by random sessionId", async () => {
  const userDoc = {
    discordId: "user-1",
    accounts: [
      {
        accountName: "Alpha",
        characters: [
          { id: "c1", name: "Main", class: "Bard", itemLevel: 1745, isGoldEarner: false },
          { id: "c2", name: "Alt", class: "Paladin", itemLevel: 1730, isGoldEarner: false },
        ],
      },
    ],
  };
  const cmd = makeCommand({
    User: { findOne: async () => userDoc },
  });

  let replyArg = null;
  const interaction = {
    user: { id: "user-1" },
    options: { getString: (name) => (name === "roster" ? "Alpha" : null) },
    reply: async (arg) => {
      replyArg = arg;
    },
    editReply: async () => {},
  };

  await cmd.handleRaidGoldEarnerCommand(interaction);

  assert.ok(replyArg, "should reply with picker embed");
  assert.equal(replyArg.embeds.length, 1);
  // 5-min ephemeral picker - exactly one session was created in cache.
  assert.equal(cmd.__test.sessions.size, 1);
  // Drain the session timer so the test process can exit.
  for (const [sid, session] of cmd.__test.sessions.entries()) {
    if (session.timer) clearTimeout(session.timer);
    cmd.__test.sessions.delete(sid);
  }
});

test("handleRaidGoldEarnerCommand: rejects with notice embed when roster name doesn't match any saved account", async () => {
  const cmd = makeCommand({
    User: { findOne: async () => ({ accounts: [{ accountName: "Alpha", characters: [] }] }) },
  });
  let replyArg = null;
  const interaction = {
    user: { id: "user-1" },
    options: { getString: (name) => (name === "roster" ? "Bravo" : null) },
    reply: async (arg) => {
      replyArg = arg;
    },
  };
  await cmd.handleRaidGoldEarnerCommand(interaction);
  assert.ok(replyArg, "should reply with rejection notice");
  // Empty session cache - no picker was opened.
  assert.equal(cmd.__test.sessions.size, 0);
});

test("handleRaidGoldEarnerCommand: rejects with notice embed when roster is empty (no characters)", async () => {
  const cmd = makeCommand({
    User: { findOne: async () => ({ accounts: [{ accountName: "Empty", characters: [] }] }) },
  });
  let replyArg = null;
  const interaction = {
    user: { id: "user-1" },
    options: { getString: () => "Empty" },
    reply: async (arg) => {
      replyArg = arg;
    },
  };
  await cmd.handleRaidGoldEarnerCommand(interaction);
  assert.ok(replyArg, "should reply with rejection notice");
  assert.equal(cmd.__test.sessions.size, 0);
});

// --------- handleRaidGoldEarnerButton ---------

test("handleRaidGoldEarnerButton: cap-6 enforcement on toggle - 7th tick rejected with ephemeral notice, no state change", async () => {
  const cmd = makeCommand();
  // Inject a session manually rather than going through the full
  // command flow (avoids needing Mongo + Discord mocks).
  const session = {
    sessionId: "sess1",
    callerId: "user-1",
    accountName: "Alpha",
    chars: [
      { id: "c1", name: "Main", class: "Bard", itemLevel: 1745, isGoldEarner: false },
      { id: "c2", name: "B", class: "Bard", itemLevel: 1740, isGoldEarner: false },
      { id: "c3", name: "C", class: "Bard", itemLevel: 1735, isGoldEarner: false },
      { id: "c4", name: "D", class: "Bard", itemLevel: 1730, isGoldEarner: false },
      { id: "c5", name: "E", class: "Bard", itemLevel: 1725, isGoldEarner: false },
      { id: "c6", name: "F", class: "Bard", itemLevel: 1720, isGoldEarner: false },
      { id: "c7", name: "G", class: "Bard", itemLevel: 1715, isGoldEarner: false },
    ],
    selectedIndices: new Set([0, 1, 2, 3, 4, 5]), // already at cap
    overflowCount: 0,
    timer: null,
  };
  cmd.__test.sessions.set("sess1", session);

  let replyArg = null;
  let updatedArg = null;
  const interaction = {
    user: { id: "user-1" },
    customId: "gold-earner:toggle:sess1:6", // 7th char (index 6)
    reply: async (arg) => {
      replyArg = arg;
    },
    update: async (arg) => {
      updatedArg = arg;
    },
    deferUpdate: async () => {},
  };

  await cmd.handleRaidGoldEarnerButton(interaction);
  // Selection state must NOT change (7th tick rejected).
  assert.equal(session.selectedIndices.size, 6);
  assert.ok(!session.selectedIndices.has(6));
  // Ephemeral notice was sent; embed wasn't re-rendered.
  assert.ok(replyArg, "should send ephemeral cap notice");
  assert.equal(updatedArg, null);

  cmd.__test.sessions.clear();
});

test("handleRaidGoldEarnerButton: untick frees a slot, allows tick again", async () => {
  const cmd = makeCommand();
  const session = {
    sessionId: "sess1",
    callerId: "user-1",
    accountName: "Alpha",
    chars: [
      { id: "c1", name: "Main", class: "Bard", itemLevel: 1745, isGoldEarner: true },
    ],
    selectedIndices: new Set([0]),
    overflowCount: 0,
    timer: null,
  };
  cmd.__test.sessions.set("sess1", session);

  let updatedCount = 0;
  const interaction = {
    user: { id: "user-1" },
    customId: "gold-earner:toggle:sess1:0",
    update: async () => {
      updatedCount += 1;
    },
    reply: async () => {},
    deferUpdate: async () => {},
  };

  // Untick - state empties, embed re-renders.
  await cmd.handleRaidGoldEarnerButton(interaction);
  assert.equal(session.selectedIndices.size, 0);
  assert.equal(updatedCount, 1);

  // Tick again - state grows back to 1.
  await cmd.handleRaidGoldEarnerButton(interaction);
  assert.equal(session.selectedIndices.size, 1);
  assert.equal(updatedCount, 2);

  cmd.__test.sessions.clear();
});

test("handleRaidGoldEarnerButton: stale sessionId (not in cache) renders 'phiên đã hết' embed", async () => {
  const cmd = makeCommand();
  let updateArg = null;
  const interaction = {
    user: { id: "user-1" },
    customId: "gold-earner:cancel:does-not-exist",
    update: async (arg) => {
      updateArg = arg;
    },
  };
  await cmd.handleRaidGoldEarnerButton(interaction);
  assert.ok(updateArg, "stale button should swap to expired-session embed");
  assert.equal(updateArg.components.length, 0);
});

test("handleRaidGoldEarnerButton: ownership guard blocks a second user from clicking another user's session", async () => {
  const cmd = makeCommand();
  cmd.__test.sessions.set("sess1", {
    sessionId: "sess1",
    callerId: "user-1",
    accountName: "Alpha",
    chars: [{ id: "c1", name: "Main", itemLevel: 1745, isGoldEarner: false }],
    selectedIndices: new Set(),
    overflowCount: 0,
    timer: null,
  });

  let replyArg = null;
  const interaction = {
    user: { id: "user-2" }, // different user
    customId: "gold-earner:toggle:sess1:0",
    reply: async (arg) => {
      replyArg = arg;
    },
    update: async () => {
      throw new Error("update should not be called for foreign user");
    },
    deferUpdate: async () => {},
  };
  await cmd.handleRaidGoldEarnerButton(interaction);
  assert.ok(replyArg, "should send lock notice");
  assert.equal(replyArg.flags, MessageFlags.Ephemeral);

  cmd.__test.sessions.clear();
});

// --------- Confirm save semantics ---------

test("handleRaidGoldEarnerButton confirm: writes isGoldEarner=true on selected, false on unselected, off-window chars untouched", async () => {
  // Roster has 22 chars (overflows the 20-cap picker by 2). Picker
  // shows top-20-by-iLvl, off-window are the 2 lowest. Confirm should
  // only mutate the 20 picker chars; the 2 off-window keep whatever
  // value they had in the source doc.
  const docCharacters = [];
  for (let i = 0; i < 22; i += 1) {
    docCharacters.push({
      id: `c${i}`,
      name: `Char${i}`,
      class: "Bard",
      itemLevel: 1745 - i, // strictly desc
      isGoldEarner: i === 21, // off-window char gets a stamped value to verify preservation
    });
  }
  const userDoc = {
    discordId: "user-1",
    accounts: [{ accountName: "Alpha", characters: docCharacters }],
    save: async () => {},
  };

  const cmd = makeCommand({
    User: { findOne: async () => userDoc },
  });

  // Inject a session that picked exactly the top 6 picker chars.
  const pickerChars = docCharacters.slice(0, 20).map((c) => ({
    id: c.id,
    name: c.name,
    class: c.class,
    itemLevel: c.itemLevel,
    isGoldEarner: c.isGoldEarner,
  }));
  cmd.__test.sessions.set("sess1", {
    sessionId: "sess1",
    callerId: "user-1",
    accountName: "Alpha",
    chars: pickerChars,
    selectedIndices: new Set([0, 1, 2, 3, 4, 5]),
    overflowCount: 2,
    timer: null,
  });

  let confirmEmbedArg = null;
  const interaction = {
    user: { id: "user-1" },
    customId: "gold-earner:confirm:sess1",
    update: async (arg) => {
      confirmEmbedArg = arg;
    },
  };
  await cmd.handleRaidGoldEarnerButton(interaction);

  // First 6 picker chars → true.
  for (let i = 0; i < 6; i += 1) {
    assert.equal(docCharacters[i].isGoldEarner, true, `char ${i} should be earner`);
  }
  // Picker chars 6..19 → explicitly false.
  for (let i = 6; i < 20; i += 1) {
    assert.equal(docCharacters[i].isGoldEarner, false, `char ${i} should be non-earner`);
  }
  // Off-window chars (20, 21) preserve their original value.
  assert.equal(docCharacters[20].isGoldEarner, false);
  assert.equal(docCharacters[21].isGoldEarner, true, "off-window char must keep its stamped value");

  // Confirm embed surfaces the saved list.
  assert.ok(confirmEmbedArg);
  assert.equal(cmd.__test.sessions.size, 0, "session should be removed on confirm");
});
