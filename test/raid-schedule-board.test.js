const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { UI } = require("../bot/utils/raid/common/shared");
const {
  buildScheduleEmbed,
  buildScheduleComponents,
  renderRsvpLine,
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

test("buildScheduleComponents (open) has 3 rows with the rse: scheme", () => {
  const rows = buildScheduleComponents(makeEvent(), compDeps);
  assert.equal(rows.length, 3);
  const ids = customIds(rows);
  assert.ok(ids.includes("rse:join:abcdef123456"));
  assert.ok(ids.includes("rse:rsvp:late:abcdef123456"));
  assert.ok(ids.includes("rse:room:abcdef123456"));
  assert.ok(ids.includes("rse:end:abcdef123456"));
  assert.ok(ids.includes("rse:lock:abcdef123456"));
});

test("locked event disables the join button and shows unlock", () => {
  const rows = buildScheduleComponents(makeEvent({ status: "locked" }), compDeps);
  const ids = customIds(rows);
  assert.ok(ids.includes("rse:unlock:abcdef123456"));
  const join = rows[0].components.find((c) => c.data.custom_id === "rse:join:abcdef123456");
  assert.equal(join.data.disabled, true);
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
