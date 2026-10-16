"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createScheduleParticipantActions,
} = require("../bot/handlers/raid/schedule/actions/participant-actions");

test("participant pick resolves a saved character ID after the roster order changes", async () => {
  const event = {
    guildId: "guild", status: "open", raidKey: "armoche", minItemLevel: 1700,
    signups: [], save: async () => {},
  };
  const roster = { accounts: [{ accountName: "Roster", characters: [
    { id: "gamma", name: "Gamma", class: "Bard", itemLevel: 1800 },
    { id: "beta", name: "Beta", class: "Bard", itemLevel: 1800 },
  ] }] };
  const actions = createScheduleParticipantActions({
    User: { findOne: () => ({ lean: async () => roster }) },
    boardLang: async () => "en",
    editBoardMessage: async () => true,
    markSignups: (target, signups) => { target.signups = signups; },
    editNotice: async (_interaction, _lang, severity) => assert.equal(severity, "success"),
  });
  await actions.handlePick({ user: { id: "owner" }, values: ["beta"] }, event, "en");
  assert.equal(event.signups.length, 1);
  assert.equal(event.signups[0].characterName, "Beta");
});

test("a character that cleared the raid this week can sign up for next week's event", async () => {
  const clearedAt = Date.parse("2026-10-09T12:00:00Z");
  const event = {
    guildId: "guild", status: "open", raidKey: "armoche", minItemLevel: 1700,
    startAt: new Date("2026-10-16T12:00:00Z"), signups: [], save: async () => {},
  };
  const roster = { accounts: [{ accountName: "Roster", characters: [{
    id: "beta", name: "Beta", class: "Bard", itemLevel: 1800,
    assignedRaids: { armoche: { G1: { completedDate: clearedAt }, G2: { completedDate: clearedAt } } },
  }] }] };
  const actions = createScheduleParticipantActions({
    User: { findOne: () => ({ lean: async () => roster }) },
    boardLang: async () => "en",
    editBoardMessage: async () => true,
    markSignups: (target, signups) => { target.signups = signups; },
    editNotice: async (_interaction, _lang, severity) => assert.equal(severity, "success"),
  });
  await actions.handlePick({ user: { id: "owner" }, values: ["beta"] }, event, "en");
  assert.equal(event.signups.length, 1);
});

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

for (const [status, titleKey, descriptionKey] of [
  ["locked", "lockedTitle", "lockedDescription"],
  ["cancelled", "eventClosedTitle", "eventClosedDescription"],
]) {
  test(`join on a ${status} board shows ${titleKey} without opening the picker`, async () => {
    const notices = [];
    const actions = createScheduleParticipantActions({
      replyNotice: async (_interaction, _lang, severity, title, description) => {
        notices.push({ severity, title, description });
      },
    });
    const interaction = {
      user: { id: "member" },
      deferReply: async () => assert.fail("a non-open board must not open the picker"),
    };

    await actions.handleJoin(interaction, { status }, "en");

    assert.deepEqual(notices, [{ severity: "warn", title: titleKey, description: descriptionKey }]);
  });

  test(`pick on a ${status} board shows ${titleKey} and saves nothing`, async () => {
    const notices = [];
    const event = {
      status,
      signups: [],
      save: async () => assert.fail("a non-open board must not save a signup"),
    };
    const actions = createScheduleParticipantActions({
      editNotice: async (_interaction, _lang, severity, title, description) => {
        notices.push({ severity, title, description });
      },
    });

    await actions.handlePick({ user: { id: "member" }, values: ["beta"] }, event, "en");

    assert.deepEqual(notices, [{ severity: "warn", title: titleKey, description: descriptionKey }]);
  });
}
