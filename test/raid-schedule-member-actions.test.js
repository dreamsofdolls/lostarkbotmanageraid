const test = require("node:test");
const assert = require("node:assert/strict");

const { createScheduleMemberActions } = require("../bot/handlers/raid/schedule/actions/member-actions");

function makeUserModel(userDoc, calls) {
  return {
    findOne(query) {
      calls.push(query);
      return {
        lean: async () => userDoc,
      };
    },
  };
}

function makeActions(userDoc, calls = {}) {
  calls.findOne = [];
  calls.saved = 0;
  calls.boardEdits = [];
  calls.notices = [];
  return createScheduleMemberActions({
    User: makeUserModel(userDoc, calls.findOne),
    boardLang: async () => "vi",
    editBoardMessage: async (interaction, event, lang) => {
      calls.boardEdits.push({ event, lang });
      return true;
    },
    rejectUnlessLeadMutable: async () => false,
    replyNotice: async () => {},
    editNotice: async (...args) => calls.notices.push(args),
    noticeEmbed: (type, title, description) => ({ type, title, description }),
    kickSelectPayload: () => ({}),
    addUserSelectPayload: () => ({}),
    addCharSelectPayload: () => ({}),
    markSignups: (event, signups) => {
      event.signups = signups;
    },
    markTurns: () => {},
  });
}

test("schedule member add-pick parses nested target id and adds that user's character", async () => {
  const userDoc = {
    accounts: [{
      accountName: "Roster A",
      characters: [{
        name: "Qiylyn",
        class: "Bard",
        itemLevel: 1725,
        assignedRaids: {},
      }],
    }],
  };
  const event = {
    _id: "event1",
    guildId: "guild1",
    channelId: "channel1",
    raidKey: "armoche",
    minItemLevel: 1700,
    supSlots: 1,
    dpsSlots: 3,
    skipNotify: true,
    signups: [],
    title: "Tonight",
    startAt: new Date(Date.UTC(2026, 5, 5, 13, 0)),
    save: async () => {
      event.saved = (event.saved || 0) + 1;
    },
  };
  const interaction = {
    customId: "rse:addpick:target-user:event1",
    values: ["0"],
    editReplyCalls: [],
    editReply(payload) {
      this.editReplyCalls.push(payload);
    },
  };
  const calls = {};
  const actions = makeActions(userDoc, calls);

  await actions.handleAddPickSelect(interaction, event, "vi");

  assert.deepEqual(calls.findOne, [{ discordId: "target-user" }]);
  assert.equal(event.saved, 1);
  assert.equal(calls.boardEdits.length, 1);
  assert.equal(event.signups.length, 1);
  assert.equal(event.signups[0].discordId, "target-user");
  assert.equal(event.signups[0].characterName, "Qiylyn");
  assert.equal(interaction.editReplyCalls.length, 1);
  assert.deepEqual(interaction.editReplyCalls[0].components, []);
});
