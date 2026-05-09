process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");

const { createRaidAutoManageCommand } = require("../bot/handlers/raid-auto-manage");
const { normalizeName } = require("../bot/utils/raid/shared");

function makeUserStub(doc) {
  return {
    findOne: () => ({
      lean: () => Promise.resolve(doc),
    }),
  };
}

function makeCommand(User) {
  return createRaidAutoManageCommand({
    EmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
    User,
    normalizeName,
  });
}

test("raid-auto-manage action:sync rejects while local-sync is active", async () => {
  const replies = [];
  const { handleRaidAutoManageCommand } = makeCommand(
    makeUserStub({ language: "vi", localSyncEnabled: true, autoManageEnabled: false })
  );
  await handleRaidAutoManageCommand({
    user: { id: "u-local" },
    options: {
      getString: (name) => (name === "action" ? "sync" : null),
    },
    reply: async (payload) => {
      replies.push(payload);
    },
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
  assert.match(replies[0].embeds[0].data.title, /local-sync/i);
  assert.match(replies[0].embeds[0].data.description, /Web Companion/);
});

test("raid-auto-manage autocomplete hides bible sync while local-sync is active", async () => {
  const responses = [];
  const { handleRaidAutoManageAutocomplete } = makeCommand(
    makeUserStub({ language: "vi", localSyncEnabled: true, autoManageEnabled: false })
  );

  await handleRaidAutoManageAutocomplete({
    user: { id: "u-local" },
    options: {
      getFocused: () => ({ name: "action", value: "" }),
    },
    respond: async (choices) => {
      responses.push(choices);
    },
  });

  assert.equal(responses.length, 1);
  assert.deepEqual(
    responses[0].map((choice) => choice.value),
    ["status", "local-off"]
  );
});
