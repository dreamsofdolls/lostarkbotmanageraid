const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require("discord.js");
const { UI } = require("../bot/utils/raid/common/shared");
const { createScheduleNoticeHelpers } = require("../bot/handlers/raid/schedule/notices");
const { createSchedulePanelBuilders } = require("../bot/handlers/raid/schedule/panels");

const EVENT_ID = "abcdef123456";

function makeEvent(extra = {}) {
  return {
    _id: EVENT_ID,
    guildId: "g1",
    channelId: "c1",
    creatorId: "lead1",
    raidKey: "armoche",
    modeKey: "hard",
    minItemLevel: 1720,
    partySize: 4,
    supSlots: 1,
    dpsSlots: 3,
    title: "Tonight",
    startAt: new Date(Date.UTC(2026, 5, 5, 13, 0)),
    status: "open",
    signups: [
      {
        discordId: "sup1",
        accountName: "Main",
        characterName: "Qiylyn",
        characterClass: "Bard",
        characterItemLevel: 1725,
        role: "support",
        status: "confirmed",
        joinedAt: 1,
      },
      {
        discordId: "dps1",
        accountName: "Alt",
        characterName: "Morrah",
        characterClass: "Berserker",
        characterItemLevel: 1722,
        role: "dps",
        status: "confirmed",
        joinedAt: 2,
      },
    ],
    turns: [{ name: "Turn 1", memberIds: ["sup1"] }],
    ...extra,
  };
}

function makePanels(ephemeralFlag = 64) {
  const { noticeEmbed } = createScheduleNoticeHelpers({
    EmbedBuilder,
    UI,
    ephemeralFlag,
  });
  return createSchedulePanelBuilders({
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder,
    EmbedBuilder,
    UI,
    ephemeralFlag,
    noticeEmbed,
  });
}

function customIds(rows) {
  return rows.flatMap((row) => row.components.map((component) => component.data.custom_id));
}

test("schedule manage panel keeps lead controls grouped and ephemeral", () => {
  const panels = makePanels();
  const payload = panels.manageMenuPayload(makeEvent(), "vi");

  assert.equal(payload.flags, 64);
  assert.equal(payload.components.length, 3);
  assert.deepEqual(customIds(payload.components), [
    `rse:lock:${EVENT_ID}`,
    `rse:setroom:${EVENT_ID}`,
    `rse:edittime:${EVENT_ID}`,
    `rse:notify:${EVENT_ID}`,
    `rse:teams:${EVENT_ID}`,
    `rse:addmember:${EVENT_ID}`,
    `rse:kick:${EVENT_ID}`,
    `rse:end:${EVENT_ID}`,
    `rse:cancel:${EVENT_ID}`,
    `rse:delete:${EVENT_ID}`,
  ]);
  assert.match(payload.embeds[0].data.description, /\*\*2\/4\*\*/);

  const locked = panels.manageMenuPayload(makeEvent({ status: "locked" }), "vi");
  assert.equal(locked.components[0].components[0].data.custom_id, `rse:unlock:${EVENT_ID}`);
});

test("schedule delete, kick, and add-member panels expose stable custom ids", () => {
  const panels = makePanels();
  const event = makeEvent();

  assert.deepEqual(customIds(panels.deleteConfirmPayload(event, "vi").components), [
    `rse:delyes:${EVENT_ID}`,
    `rse:delno:${EVENT_ID}`,
  ]);

  const kickSelect = panels.kickSelectPayload(event, "vi").components[0].components[0];
  assert.equal(kickSelect.data.custom_id, `rse:kickpick:${EVENT_ID}`);
  assert.equal(kickSelect.options.length, 2);

  const addUserSelect = panels.addUserSelectPayload(event, "vi").components[0].components[0];
  assert.equal(addUserSelect.data.custom_id, `rse:adduser:${EVENT_ID}`);

  const addCharSelect = panels.addCharSelectPayload(event, "target1", [{
    index: 7,
    accountName: "Main",
    name: "Qiylyn",
    className: "Bard",
    itemLevel: 1725,
    role: "support",
    alreadyCleared: false,
  }], "vi").components[0].components[0];
  assert.equal(addCharSelect.data.custom_id, `rse:addpick:target1:${EVENT_ID}`);
  assert.equal(addCharSelect.options[0].data.value, "7");
});

test("schedule teams panels preserve selected turn members", () => {
  const panels = makePanels();
  const event = makeEvent();

  const turnSelect = panels.teamsPanelPayload(event, "vi").components[0].components[0];
  assert.equal(turnSelect.data.custom_id, `rse:teamturn:${EVENT_ID}`);
  assert.equal(turnSelect.options.at(-1).data.value, "new");

  const memberSelect = panels.memberSelectPayload(event, 0, "vi").components[0].components[0];
  assert.equal(memberSelect.data.custom_id, `rse:teammembers:0:${EVENT_ID}`);
  const current = memberSelect.options.find((option) => option.data.value === "sup1");
  assert.equal(current.data.default, true);
});

test("schedule turn-plan dashboard adds a showtp switcher only for multiple boards", () => {
  const panels = makePanels();
  const current = makeEvent();
  const other = makeEvent({
    _id: "fedcba654321",
    title: "Other",
    startAt: new Date(Date.UTC(2026, 5, 6, 13, 0)),
  });

  const single = panels.turnPlanDashboardPayload(current, [current], "vi");
  assert.equal(single.flags, 64);
  assert.equal(single.components.length, 0);

  const multi = panels.turnPlanDashboardPayload(current, [current, other], "vi");
  assert.equal(multi.components.length, 1);
  const switcher = multi.components[0].components[0];
  assert.equal(switcher.data.custom_id, `rse:showtp:${EVENT_ID}`);
  const selected = switcher.options.find((option) => option.data.value === EVENT_ID);
  assert.equal(selected.data.default, true);
});
