const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseScheduleCustomId,
  resolveScheduleActionHandler,
} = require("../bot/handlers/raid/schedule/router");

test("schedule router parses rse custom ids with nested action segments", () => {
  assert.deepEqual(parseScheduleCustomId("rse:join:abcdef123456"), {
    action: "join",
    eventId: "abcdef123456",
  });
  assert.deepEqual(parseScheduleCustomId("rse:addpick:target1:abcdef123456"), {
    action: "addpick:target1",
    eventId: "abcdef123456",
  });
  assert.equal(parseScheduleCustomId("other:join:abcdef123456"), null);
  assert.equal(parseScheduleCustomId("rse:missing-event"), null);
});

test("schedule router resolves exact actions before prefix actions", async () => {
  const calls = [];
  const exact = {
    join: async () => calls.push("join"),
    "rsvp:special": async () => calls.push("exact-special"),
  };
  const prefixes = [
    {
      prefix: "rsvp:",
      create: (action) => async () => calls.push(`prefix-${action}`),
    },
  ];

  await resolveScheduleActionHandler("join", exact, prefixes)();
  await resolveScheduleActionHandler("rsvp:special", exact, prefixes)();
  await resolveScheduleActionHandler("rsvp:late", exact, prefixes)();

  assert.deepEqual(calls, ["join", "exact-special", "prefix-rsvp:late"]);
});

test("schedule router returns null for missing or unknown actions", () => {
  const exact = { join: async () => {} };
  const prefixes = [{ prefix: "rsvp:", create: () => async () => {} }];

  assert.equal(resolveScheduleActionHandler("", exact, prefixes), null);
  assert.equal(resolveScheduleActionHandler(null, exact, prefixes), null);
  assert.equal(resolveScheduleActionHandler("unknown", exact, prefixes), null);
});
