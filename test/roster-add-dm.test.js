"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTargetDmDelivery,
} = require("../bot/handlers/roster/add/dm");

function createSession(overrides = {}) {
  return {
    actingForOther: true,
    targetId: "target-1",
    ...overrides,
  };
}

test("raid-add target DM delivery sends localized embed to the target", async () => {
  const sends = [];
  const service = createTargetDmDelivery({
    User: {},
    getUserLanguage: async (targetId) => {
      assert.equal(targetId, "target-1");
      return "en";
    },
    buildTargetDMEmbed: (session, savedAccount, guildName, lang) => ({
      session,
      savedAccount,
      guildName,
      lang,
    }),
  });
  const client = {
    users: {
      fetch: async (targetId) => {
        assert.equal(targetId, "target-1");
        return {
          send: async (payload) => sends.push(payload),
        };
      },
    },
  };

  const result = await service.tryDeliverTargetDM(
    client,
    createSession(),
    { accountName: "Roster", characters: [] },
    "Guild"
  );

  assert.deepEqual(result, { delivered: true });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].embeds[0].lang, "en");
});

test("raid-add target DM delivery classifies Discord 50007 as DMs disabled", async () => {
  const warns = [];
  const service = createTargetDmDelivery({
    User: {},
    getUserLanguage: async () => "vi",
    buildTargetDMEmbed: () => ({}),
    logger: { warn: (...args) => warns.push(args) },
  });
  const client = {
    users: {
      fetch: async () => ({
        send: async () => {
          const err = new Error("Cannot send");
          err.code = 50007;
          throw err;
        },
      }),
    },
  };

  const result = await service.tryDeliverTargetDM(
    client,
    createSession(),
    { accountName: "Roster", characters: [] },
    "Guild"
  );

  assert.deepEqual(result, { delivered: false, reason: "dms-disabled" });
  assert.equal(warns.length, 1);
});

test("raid-add target DM delivery no-ops for self-add sessions", async () => {
  const service = createTargetDmDelivery({
    User: {},
    getUserLanguage: async () => {
      throw new Error("should not resolve language");
    },
    buildTargetDMEmbed: () => ({}),
  });

  const result = await service.tryDeliverTargetDM(
    {},
    createSession({ actingForOther: false }),
    {},
    null
  );

  assert.deepEqual(result, {
    delivered: false,
    reason: "not-acting-for-other",
  });
});
