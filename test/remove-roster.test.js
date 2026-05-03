// Tests for /remove-roster.
//
// All write logic is inline in handleRemoveRosterCommand, so tests
// drive the handler with a minimal mock interaction. Key behaviors
// covered: remove_roster wipes the whole account, remove_char preserves
// the rest, the seed-reseed step picks a non-colliding fallback name,
// and validation paths reject bad inputs without touching state.

process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder, MessageFlags } = require("discord.js");

const { createRemoveRosterCommand } = require("../bot/handlers/remove-roster");
const {
  UI,
  normalizeName,
  getCharacterName,
  getCharacterClass,
} = require("../bot/utils/raid/shared");
const { createCharacterId } = require("../bot/utils/raid/character");

function makeUserModel() {
  const docs = new Map();
  class User {
    constructor(data = {}) {
      this.discordId = data.discordId || null;
      this.accounts = JSON.parse(JSON.stringify(data.accounts || []));
    }
    async save() {
      docs.set(this.discordId, {
        discordId: this.discordId,
        accounts: JSON.parse(JSON.stringify(this.accounts)),
      });
      return this;
    }
    static findOne(query) {
      const data = docs.get(query.discordId);
      return {
        async lean() {
          return data ? JSON.parse(JSON.stringify(data)) : null;
        },
        then(resolve, reject) {
          const result = data ? new User(JSON.parse(JSON.stringify(data))) : null;
          return Promise.resolve(result).then(resolve, reject);
        },
      };
    }
  }
  return { User, docs };
}

function makeFactory() {
  const { User, docs } = makeUserModel();
  const factory = createRemoveRosterCommand({
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    saveWithRetry: async (op) => op(),
    ensureFreshWeek: () => false,
    normalizeName,
    getCharacterName,
    getCharacterClass,
    createCharacterId,
    loadUserForAutocomplete: async () => null,
  });
  return { factory, docs };
}

// Mock interaction that records every reply call and exposes its args.
// Mirrors discord.js's interaction surface enough for handler tests:
// `options.getString` reads from a literal options object, `reply`
// captures the call instead of dispatching to Discord. Each call appends
// to `_calls.reply` so tests can assert on the embed shape.
function makeInteraction({ user = "user-1", options = {} } = {}) {
  const calls = { reply: [] };
  return {
    user: { id: user },
    options: {
      getString: (name, required) => {
        const val = options[name];
        if (required && val == null) throw new Error(`required option ${name} missing`);
        return val == null ? null : String(val);
      },
    },
    reply: async (arg) => {
      calls.reply.push(arg);
    },
    _calls: calls,
  };
}

function seedUser(docs, accounts) {
  docs.set("user-1", {
    discordId: "user-1",
    accounts: JSON.parse(JSON.stringify(accounts)),
  });
}

function makeChar(name, itemLevel = 1700) {
  return {
    id: `${name}-id`,
    name,
    class: "Bard",
    itemLevel,
    assignedRaids: { armoche: {}, kazeros: {}, serca: {} },
    tasks: [],
  };
}

test("remove-roster: remove_roster deletes the entire account", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano"), makeChar("Bardella")] },
    { accountName: "Bravo", characters: [makeChar("Soulrano")] },
  ]);

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "remove_roster" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  const stored = docs.get("user-1");
  assert.equal(stored.accounts.length, 1);
  assert.equal(stored.accounts[0].accountName, "Bravo");
  // Reply embed should reference the removed account in the
  // Artist-voice description (cold field table dropped — content lives
  // in the description sentence now).
  const replyArg = interaction._calls.reply[0];
  const embedJson = replyArg.embeds[0].toJSON();
  assert.match(embedJson.title, /Đã xoá roster/);
  assert.match(embedJson.description, /Alpha/);
  assert.match(embedJson.description, /2\*\* character/);
});

test("remove-roster: remove_char drops one char from the account, others stay", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    {
      accountName: "Alpha",
      characters: [makeChar("Cyrano"), makeChar("Bardella"), makeChar("Soulrano")],
    },
  ]);

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "remove_char", character: "Bardella" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  const stored = docs.get("user-1");
  assert.equal(stored.accounts[0].characters.length, 2);
  assert.deepEqual(
    stored.accounts[0].characters.map((c) => c.name),
    ["Cyrano", "Soulrano"]
  );
});

test("remove-roster: remove_char on the seed char re-points accountName to next non-colliding char", async () => {
  // accountName usually mirrors the first/seed char. Removing the seed
  // must re-point to a remaining char so the bible-refresh seed list
  // (uses accountName + char names) keeps working. Reseed must avoid
  // any name that collides with another account's accountName so the
  // per-user-unique invariant on accountName stays intact.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Alpha"), makeChar("Bardella"), makeChar("Soulrano")] },
    { accountName: "Bardella", characters: [makeChar("Bardella")] }, // collides with Alpha's char
  ]);

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "remove_char", character: "Alpha" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  const stored = docs.get("user-1");
  // Alpha account should have re-pointed to "Soulrano" (skipped
  // "Bardella" because that's another account's accountName).
  const alphaAccount = stored.accounts.find((a) => a.characters.some((c) => c.name === "Bardella" && c.id === "Bardella-id"));
  // Find by char name since accountName changed
  const reseededAccount = stored.accounts.find((a) => a.accountName === "Soulrano");
  assert.ok(reseededAccount, `expected an account renamed to "Soulrano", got ${stored.accounts.map((a) => a.accountName).join(", ")}`);
  assert.equal(reseededAccount.characters.length, 2);
});

test("remove-roster: remove_char on the seed when no remaining chars leaves accountName intact", async () => {
  // Edge case: removing the only char (also the seed) leaves an empty
  // account. Schema allows accountName to point at nothing; reseed walk
  // simply has no candidate to swap to.
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Alpha")] },
  ]);

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "remove_char", character: "Alpha" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  const stored = docs.get("user-1");
  assert.equal(stored.accounts[0].accountName, "Alpha");
  assert.equal(stored.accounts[0].characters.length, 0);
});

test("remove-roster: rejects unknown action without touching state", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano")] },
  ]);

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "delete_universe" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  // State unchanged.
  const stored = docs.get("user-1");
  assert.equal(stored.accounts[0].characters.length, 1);
  // Ephemeral rejection emitted as a notice embed (Artist persona).
  const replyArg = interaction._calls.reply[0];
  assert.equal(replyArg.flags, MessageFlags.Ephemeral);
  const embedJson = replyArg.embeds[0].toJSON();
  assert.match(embedJson.title, /không hợp lệ/i);
});

test("remove-roster: rejects remove_char without a character argument", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano")] },
  ]);

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "remove_char" }, // no character
  });
  await factory.handleRemoveRosterCommand(interaction);

  const stored = docs.get("user-1");
  assert.equal(stored.accounts[0].characters.length, 1);
  const replyArg = interaction._calls.reply[0];
  assert.equal(replyArg.flags, MessageFlags.Ephemeral);
  const embedJson = replyArg.embeds[0].toJSON();
  assert.match(embedJson.title, /character/i);
});

test("remove-roster: surfaces 'No Roster' when user has no accounts", async () => {
  const { factory } = makeFactory();
  // No user doc seeded.

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "remove_roster" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  const replyArg = interaction._calls.reply[0];
  const embedJson = replyArg.embeds[0].toJSON();
  assert.match(embedJson.title, /No Roster/);
});

test("remove-roster: surfaces 'Roster Not Found' when accountName mismatch", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano")] },
  ]);

  const interaction = makeInteraction({
    options: { roster: "Charlie", action: "remove_roster" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  const replyArg = interaction._calls.reply[0];
  const embedJson = replyArg.embeds[0].toJSON();
  assert.match(embedJson.title, /Roster Not Found/);
  // Original account untouched.
  assert.equal(docs.get("user-1").accounts.length, 1);
});

test("remove-roster: surfaces 'Character Not Found' when char missing in roster", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano")] },
  ]);

  const interaction = makeInteraction({
    options: { roster: "Alpha", action: "remove_char", character: "Bardella" },
  });
  await factory.handleRemoveRosterCommand(interaction);

  const replyArg = interaction._calls.reply[0];
  const embedJson = replyArg.embeds[0].toJSON();
  assert.match(embedJson.title, /Character Not Found/);
  // Roster + char untouched.
  assert.equal(docs.get("user-1").accounts[0].characters.length, 1);
});

test("remove-roster: roster name match is case-insensitive (normalizeName)", async () => {
  const { factory, docs } = makeFactory();
  seedUser(docs, [
    { accountName: "Alpha", characters: [makeChar("Cyrano")] },
  ]);

  const interaction = makeInteraction({
    options: { roster: "ALPHA", action: "remove_roster" }, // upper case
  });
  await factory.handleRemoveRosterCommand(interaction);

  const stored = docs.get("user-1");
  assert.equal(stored.accounts.length, 0);
});
