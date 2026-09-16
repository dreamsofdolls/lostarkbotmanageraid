"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createScheduleParticipantActions,
} = require("../bot/handlers/raid/schedule/actions/participant-actions");

test("a waitlister promoted by an absent RSVP is pinged in a public follow-up", async () => {
  const event = {
    guildId: "guild-1",
    status: "open",
    supSlots: 1,
    dpsSlots: 1,
    skipNotify: false,
    signups: [
      { discordId: "leaver", characterName: "Leaver", role: "dps", status: "confirmed", joinedAt: 1 },
      { discordId: "waiter", characterName: "Waiter", role: "dps", status: "confirmed", joinedAt: 2 },
    ],
    save: async () => {},
  };
  const followUps = [];
  const actions = createScheduleParticipantActions({
    ActionRowBuilder: class {},
    StringSelectMenuBuilder: class {},
    User: {},
    ephemeralFlag: 64,
    boardLang: async () => "en",
    boardPayload: async () => ({ embeds: [] }),
    editBoardMessage: async () => true,
    isClosedEvent: () => false,
    markSignups: (target, signups) => {
      target.signups = signups;
    },
    replyNotice: async () => assert.fail("a joined member's RSVP must not be rejected"),
    editNotice: async () => {},
    noticeEmbed: () => ({}),
  });

  await actions.handleRsvp({
    user: { id: "leaver" },
    deferUpdate: async () => {},
    editReply: async () => {},
    followUp: async (payload) => {
      followUps.push(payload);
    },
  }, event, "absent", "en");

  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].flags, undefined);
  assert.match(followUps[0].content, /<@waiter>/);
});
