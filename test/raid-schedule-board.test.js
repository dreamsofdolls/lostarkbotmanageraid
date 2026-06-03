const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const { UI } = require("../bot/utils/raid/common/shared");
const {
  buildScheduleEmbed,
  buildScheduleComponents,
  buildTurnPlanEmbed,
  renderRsvpLine,
  renderGauge,
} = require("../bot/handlers/raid/schedule/board");

function makeEvent(extra = {}) {
  return {
    _id: "abcdef123456",
    guildId: "g1", channelId: "c1", creatorId: "lead1",
    raidKey: "armoche", modeKey: "hard", minItemLevel: 1720,
    partySize: 8, supSlots: 2, dpsSlots: 6,
    title: "Tonight", startAt: new Date(Date.UTC(2026, 4, 29, 13, 0)),
    status: "open", roomName: null,
    signups: [
      { discordId: "a", characterName: "Senko", characterClass: "Bard", characterItemLevel: 1725, role: "support", status: "confirmed", joinedAt: 1 },
      { discordId: "b", characterName: "Morrah", characterClass: "Berserker", characterItemLevel: 1722, role: "dps", status: "late", joinedAt: 2 },
      { discordId: "c", characterName: "Maybe", characterClass: "Deathblade", characterItemLevel: 1721, role: "dps", status: "tentative", joinedAt: 3 },
    ],
    ...extra,
  };
}

const deps = { EmbedBuilder, UI, lang: "vi" };
const compDeps = { ActionRowBuilder, ButtonBuilder, ButtonStyle, lang: "vi" };

function customIds(rows) {
  return rows.flatMap((r) => r.components.map((c) => c.data.custom_id));
}

test("renderGauge draws one block per slot (filled vs empty), clamped + safe", () => {
  assert.equal(renderGauge(5, 8), "▰▰▰▰▰▱▱▱");
  assert.equal(renderGauge(2, 4), "▰▰▱▱");
  assert.equal(renderGauge(8, 8), "▰▰▰▰▰▰▰▰");
  assert.equal(renderGauge(0, 8), "▱▱▱▱▱▱▱▱");
  assert.equal(renderGauge(10, 8), "▰▰▰▰▰▰▰▰"); // over-fill clamps to total
  assert.equal(renderGauge(0, 0), "");           // no party size -> no gauge
});

test("buildScheduleComponents (open) is 2 tidy rows; lead lock/end live in the menu", () => {
  const rows = buildScheduleComponents(makeEvent(), compDeps);
  assert.equal(rows.length, 2);
  const ids = customIds(rows);
  assert.ok(ids.includes("rse:join:abcdef123456"));
  assert.ok(ids.includes("rse:rsvp:late:abcdef123456"));
  assert.ok(ids.includes("rse:room:abcdef123456"));
  assert.ok(ids.includes("rse:help:abcdef123456"));
  assert.ok(ids.includes("rse:manage:abcdef123456"));
  // Lock/unlock + End are not on the board anymore - they moved into the
  // ephemeral Manage menu.
  assert.ok(!ids.includes("rse:end:abcdef123456"));
  assert.ok(!ids.includes("rse:lock:abcdef123456"));
  assert.ok(!ids.includes("rse:unlock:abcdef123456"));
});

test("buildScheduleComponents includes the turn-plan peek button on the utility row", () => {
  const ids = customIds(buildScheduleComponents(makeEvent(), compDeps));
  assert.ok(ids.includes("rse:turnplan:abcdef123456"));
});

test("switcher row appears only when the lead runs >= 2 boards", () => {
  const oneBoard = [{ eventId: "abcdef123456", shortId: "123456", raidKey: "armoche", modeKey: "hard", title: "Tonight", startAt: new Date(Date.UTC(2026, 5, 3, 14, 0)), compCount: 1, partySize: 8, waitlistCount: 0, isCurrent: true }];
  const twoBoards = [
    ...oneBoard,
    { eventId: "other999", shortId: "her999", raidKey: "kazeros", modeKey: "hard", title: "Echidna", startAt: new Date(Date.UTC(2026, 5, 4, 13, 0)), compCount: 8, partySize: 8, waitlistCount: 2, isCurrent: false },
  ];
  const selDeps = { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, lang: "vi" };

  // 1 board -> no switcher (a one-option dropdown is pointless).
  const single = buildScheduleComponents(makeEvent(), { ...selDeps, ownedBoardOptions: oneBoard });
  assert.equal(single.length, 2);

  // 2 boards -> a 3rd row carrying the rse:showpick select, current marked default.
  const multi = buildScheduleComponents(makeEvent(), { ...selDeps, ownedBoardOptions: twoBoards });
  assert.equal(multi.length, 3);
  const select = multi[2].components[0];
  assert.equal(select.data.custom_id, "rse:showpick:abcdef123456");
  assert.equal(select.options.length, 2);
  const current = select.options.find((o) => o.data.value === "abcdef123456");
  assert.equal(current.data.default, true);
  // shortId in the label, calendar icon, and a plain-text start date in the desc.
  assert.match(current.data.label, /123456$/);
  assert.equal(current.data.emoji.name, "🗓️");
  assert.match(current.data.description, /\d{2}\/\d{2} \d{2}:\d{2}/);
});

test("locked event disables the join button (lead unlock lives in Manage)", () => {
  const rows = buildScheduleComponents(makeEvent({ status: "locked" }), compDeps);
  const ids = customIds(rows);
  const join = rows[0].components.find((c) => c.data.custom_id === "rse:join:abcdef123456");
  assert.equal(join.data.disabled, true);
  // Manage is still reachable so the lead can unlock from the menu.
  assert.ok(ids.includes("rse:manage:abcdef123456"));
});

test("cleared / cancelled events strip all components", () => {
  assert.deepEqual(buildScheduleComponents(makeEvent({ status: "cleared" }), compDeps), []);
  assert.deepEqual(buildScheduleComponents(makeEvent({ status: "cancelled" }), compDeps), []);
});

test("buildScheduleEmbed renders support + dps fields and is a valid embed", () => {
  const embed = buildScheduleEmbed(makeEvent(), deps);
  const data = embed.data;
  assert.ok(Array.isArray(data.fields) && data.fields.length >= 2);
  // late player (Morrah) holds a dps slot -> appears in a comp field, not RSVP.
  const joined = data.fields.map((f) => f.value).join("\n");
  assert.ok(joined.includes("Senko"));
  assert.ok(joined.includes("Morrah"));
});

test("renderRsvpLine lists tentative/absent only (late stays in comp)", () => {
  const line = renderRsvpLine(makeEvent().signups, "vi");
  assert.ok(line.includes("Maybe"));      // tentative
  assert.ok(!line.includes("Morrah"));    // late -> not in RSVP line
});

test("buildTurnPlanEmbed: one field per turn, member shows mention + class + role chip", () => {
  const ev = makeEvent({
    turns: [
      { name: "Turn 1", memberIds: ["a", "b", "ghost"] }, // ghost is stale and should be dropped
      { name: "Turn 2", memberIds: ["a"] },       // overlap: a in both turns
    ],
  });
  const fields = buildTurnPlanEmbed(ev, deps).data.fields || [];
  assert.equal(fields.length, 2);
  assert.equal(fields[0].name, "Turn 1");
  const t1 = fields[0].value;
  assert.ok(t1.includes("<@a>"), "player mention rendered");
  assert.ok(t1.includes("Senko") && t1.includes("SUP"));
  assert.ok(t1.includes("Morrah") && t1.includes("DPS"));
  // overlap: 'a' appears in Turn 2 too
  assert.ok(fields[1].value.includes("<@a>"));
  assert.ok(!fields[0].value.includes("ghost"));
  assert.match(buildTurnPlanEmbed(ev, deps).data.footer.text, /2 người/);
});
