const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");

const { createTeamsViewUi } = require("../bot/handlers/raid-check/teams-view");
const { buildScheduleEmbed, buildTurnPlanEmbed } = require("../bot/handlers/raid/schedule/board");
const { UI } = require("../bot/utils/raid/common/shared");

const truncateText = (s, n) => (String(s).length <= n ? String(s) : String(s).slice(0, n));

function makeUi(overrides = {}) {
  return createTeamsViewUi({
    EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags,
    UI, truncateText, buildScheduleEmbed, buildTurnPlanEmbed,
    RaidEvent: overrides.RaidEvent || { async findById() { return null; } },
    User: overrides.User || null,
  });
}

// A pre-shaped dropdown row (buildTeamsRows takes already-shaped rows).
function shaped(id, extra = {}) {
  return {
    eventId: id, shortId: String(id).slice(-6), raidKey: "armoche", modeKey: "hard",
    channelId: "c1", creatorId: "lead",
    startAt: new Date(Date.UTC(2026, 5, 3, 14, 0)), title: `Board ${id}`, compCount: 4, partySize: 8,
    waitlistCount: 0, isCurrent: false, leadName: null, ...extra,
  };
}

function selectOf(row) {
  return row.components[0];
}

test("buildTeamsRows returns [] when there are no events", () => {
  const ui = makeUi();
  assert.deepEqual(ui.buildTeamsRows({ shapedEvents: [], maxRows: 3 }), []);
  assert.deepEqual(ui.buildTeamsRows({ shapedEvents: undefined, maxRows: 3 }), []);
  assert.deepEqual(ui.buildTeamsRows({ shapedEvents: [shaped("a")], maxRows: 0 }), []);
});

test("buildTeamsRows shows the shortId in the label and a start date in the description", () => {
  const ui = makeUi();
  const rows = ui.buildTeamsRows({ shapedEvents: [shaped("abc123")], maxRows: 3 });
  const opt = selectOf(rows[0]).options[0];
  assert.match(opt.data.label, /abc123$/, "label ends with the shortId");
  assert.equal(opt.data.emoji.name, "🗓️", "calendar icon present");
  assert.match(opt.data.description, /\d{2}\/\d{2} \d{2}:\d{2}/, "a DD/MM HH:mm start date is shown");
});

test("buildTeamsRows builds one select for <= 25 events, values carry eventIds", () => {
  const ui = makeUi();
  const rows = ui.buildTeamsRows({ shapedEvents: [shaped("e1"), shaped("e2"), shaped("e3")], maxRows: 3 });
  assert.equal(rows.length, 1);
  const select = selectOf(rows[0]);
  assert.equal(select.data.custom_id, "raid-check-all-teams:0");
  assert.equal(select.options.length, 3);
  assert.deepEqual(select.options.map((o) => o.data.value), ["e1", "e2", "e3"]);
});

test("buildTeamsRows spills > 25 events into overflow selects (chunks of 25)", () => {
  const ui = makeUi();
  const many = Array.from({ length: 30 }, (_, i) => shaped(`e${i}`));
  const rows = ui.buildTeamsRows({ shapedEvents: many, maxRows: 3 });
  assert.equal(rows.length, 2, "30 events -> 25 + 5 -> two selects");
  assert.equal(selectOf(rows[0]).options.length, 25);
  assert.equal(selectOf(rows[1]).options.length, 5);
  assert.equal(selectOf(rows[0]).data.custom_id, "raid-check-all-teams:0");
  assert.equal(selectOf(rows[1]).data.custom_id, "raid-check-all-teams:1");
});

test("buildTeamsRows never exceeds the row budget (logs dropped, no silent overflow)", () => {
  const ui = makeUi();
  const many = Array.from({ length: 60 }, (_, i) => shaped(`e${i}`)); // 3 chunks
  const rows = ui.buildTeamsRows({ shapedEvents: many, maxRows: 1 });
  assert.equal(rows.length, 1, "capped to the 1-row budget");
});

test("buildTeamsRows picks the with-lead vs no-lead option line per row", () => {
  const ui = makeUi();
  const rows = ui.buildTeamsRows({
    shapedEvents: [shaped("withLead", { leadName: "Bao" }), shaped("noLead", { leadName: null })],
    maxRows: 3,
  });
  const opts = selectOf(rows[0]).options;
  const withLead = opts.find((o) => o.data.value === "withLead");
  const noLead = opts.find((o) => o.data.value === "noLead");
  // The with-lead line interpolates the lead name; the no-lead line omits it.
  assert.match(withLead.data.description, /Bao/);
  assert.doesNotMatch(noLead.data.description, /Bao/);
});

test("handleRaidCheckTeamsSelect shows comp + turn plan as two ephemeral embeds", async () => {
  const event = {
    _id: "ev1", guildId: "g1", channelId: "c1", creatorId: "lead",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720,
    partySize: 8, supSlots: 2, dpsSlots: 6, title: "Tonight",
    startAt: new Date(Date.UTC(2026, 5, 5, 13, 0)), status: "open",
    signups: [{ discordId: "a", characterName: "Senko", characterClass: "Bard", characterItemLevel: 1725, role: "support", status: "confirmed", joinedAt: 1 }],
    turns: [{ name: "Turn 1", memberIds: ["a"] }],
  };
  const ui = makeUi({ RaidEvent: { async findById(id) { return id === "ev1" ? event : null; } } });
  let payload = null;
  const interaction = { async reply(p) { payload = p; return p; } };

  await ui.handleRaidCheckTeamsSelect(interaction, "ev1", "en");

  assert.equal(payload.embeds.length, 2, "comp embed + turn-plan embed");
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  assert.equal(payload.embeds[0].data.author.name, "// SIGNUP BOARD");
  assert.equal(payload.embeds[1].data.author.name, "// TURN PLAN · BUS");
});

test("handleRaidCheckTeamsSelect warns when the picked event is gone or closed", async () => {
  const cleared = { _id: "ev2", status: "cleared" };
  const ui = makeUi({ RaidEvent: { async findById(id) { return id === "ev2" ? cleared : null; } } });

  for (const id of ["ev2", "missing"]) {
    let payload = null;
    await ui.handleRaidCheckTeamsSelect({ async reply(p) { payload = p; } }, id, "en");
    assert.equal(payload.embeds.length, 1, `${id}: single notice embed`);
    assert.equal(payload.flags, MessageFlags.Ephemeral);
  }
});

test("loadActiveEventsForTeams queries active events, shapes them, attaches lead names", async () => {
  const docs = [
    { _id: "ev1", guildId: "g1", channelId: "c1", creatorId: "lead1", raidKey: "armoche", modeKey: "hard", partySize: 8, supSlots: 2, dpsSlots: 6, title: "A", startAt: new Date(2), signups: [] },
    { _id: "ev2", guildId: "g1", channelId: "c2", creatorId: "lead2", raidKey: "kazeros", modeKey: "hard", partySize: 8, supSlots: 2, dpsSlots: 6, title: "B", startAt: new Date(1), signups: [] },
  ];
  const RaidEvent = { find: () => ({ sort: () => ({ lean: async () => docs }) }) };
  const User = { find: () => ({ select: () => ({ lean: async () => [{ discordId: "lead1", discordDisplayName: "Bao" }] }) }) };
  const ui = makeUi({ RaidEvent, User });

  const rows = await ui.loadActiveEventsForTeams({ guildId: "g1" });
  assert.equal(rows.length, 2);
  // Sorted by startAt asc -> ev2 (date 1) first.
  assert.equal(rows[0].eventId, "ev2");
  assert.equal(rows[1].eventId, "ev1");
  assert.equal(rows[1].leadName, "Bao", "resolved lead name attached");
  assert.equal(rows[0].leadName, null, "unknown lead falls back to null");
  assert.deepEqual(await ui.loadActiveEventsForTeams({ guildId: null }), []);
});
