const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");

const { buildCompactTurnPlan, ansiColorForName } = require("../bot/handlers/raid/schedule/board");
const { createRaidScheduleCommand } = require("../bot/handlers/raid/schedule");
const { t } = require("../bot/services/i18n");
const { UI } = require("../bot/utils/raid/common/shared");

const plain = (s) => s.replace(/\[[0-9]*m/g, ""); // strip ANSI for content asserts
const EMPTY = t("raid-schedule.board.emptySlot", "vi");
const COMP_ONLY = t("raid-schedule.compact.compOnly", "vi");

function sup(id, name) {
  return { discordId: id, characterName: name, characterClass: "Bard", role: "support" };
}
function dps(id, name) {
  return { discordId: id, characterName: name, characterClass: "Sorceress", role: "dps" };
}
function makeEvent(extra = {}) {
  return {
    _id: "507f1f77bcf86cd799439abc", raidKey: "serca", modeKey: "hard", status: "locked",
    startAt: new Date(Date.UTC(2026, 5, 3, 14, 0)),
    roomName: "act4-bus", roomPassword: "7421",
    partySize: 4, supSlots: 1, dpsSlots: 3,
    signups: [sup("u2", "2key"), dps("u1", "Du"), dps("u3", "Pink")],
    turns: [{ name: "1-4", memberIds: ["u1", "u3", "u2"] }, { name: "5", memberIds: ["u1"] }],
    ...extra,
  };
}

function makeCommand(event) {
  const User = { findOne: () => ({ lean: async () => ({ language: "vi" }) }) };
  const GuildConfig = { findOne: () => ({ lean: async () => null }) };
  const RaidEvent = {
    async findById(id) {
      return String(id) === String(event._id) ? event : null;
    },
  };
  return createRaidScheduleCommand({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    UI,
    User,
    GuildConfig,
    RaidEvent,
    isManagerId: (id) => id === "lead",
    applyRaidSetBatchForDiscordId: async () => [],
  });
}

test("buildCompactTurnPlan is a fenced ```ansi block with header, turns, footer", () => {
  const out = buildCompactTurnPlan(makeEvent(), { lang: "vi", canSeeRoom: true });
  assert.ok(out.startsWith("```ansi\n"), "opens an ansi code fence");
  assert.ok(out.endsWith("\n```"), "closes the fence");
  const text = plain(out);
  assert.match(text, /OPS BRIEF · SERCA HARD/);
  assert.match(text, /\[LOCKED\]/);
  assert.match(text, /S1-4/);
  assert.match(text, /S5/);
  assert.ok(text.includes("Du") && text.includes("Pink") && text.includes("2key"), "character names rendered");
  assert.match(text, /#439abc/, "footer shows the 6-char shortId");
});

test("buildCompactTurnPlan pads unfilled slots with the board's empty label", () => {
  // Turn "5" has 1 DPS + 0 SUP; dpsSlots 3, supSlots 1 -> 2 empty DPS + 1 empty SUP.
  const text = plain(buildCompactTurnPlan(makeEvent(), { lang: "vi", canSeeRoom: true }));
  const line5 = text.split("\n").find((l) => l.includes("S5"));
  const empties = line5.split(EMPTY).length - 1;
  assert.equal(empties, 3, "2 empty DPS + 1 empty SUP rendered as 'trống'");
});

test("buildCompactTurnPlan gates the room password (id) behind comp membership", () => {
  const seen = plain(buildCompactTurnPlan(makeEvent(), { lang: "vi", canSeeRoom: true }));
  assert.ok(seen.includes("7421"), "comp/lead sees the room id");

  const hidden = plain(buildCompactTurnPlan(makeEvent(), { lang: "vi", canSeeRoom: false }));
  assert.ok(!hidden.includes("7421"), "non-comp does NOT see the room id");
  assert.ok(hidden.includes(COMP_ONLY), "shows the comp-only lock instead");
  assert.ok(hidden.includes("act4-bus"), "room NAME stays visible to everyone");
});

test("tpcompact keeps room password hidden from a non-comp manager", async () => {
  const event = makeEvent({ creatorId: "lead", guildId: "g1", channelId: "c1" });
  const command = makeCommand(event);
  let payload = null;

  await command.handleRaidScheduleButton({
    customId: `rse:tpcompact:${event._id}`,
    user: { id: "lead" },
    async update(next) {
      payload = next;
    },
  });

  const text = plain(payload.content);
  assert.ok(!text.includes("7421"), "manager outside comp does not see room id");
  assert.ok(text.includes(COMP_ONLY), "manager outside comp gets the comp-only marker");
  assert.ok(text.includes("act4-bus"), "room name remains visible");
});

test("ansiColorForName is stable per name and always a non-gray fg code", () => {
  assert.equal(ansiColorForName("Du"), ansiColorForName("Du"), "same name -> same colour");
  for (const n of ["Du", "Bao", "2key", "Meo Paul", "DK", "Pink", "Agi", "Linhie"]) {
    const c = ansiColorForName(n);
    assert.ok(c >= 31 && c <= 37, `${n} -> ${c} is in 31..37 (gray 30 reserved)`);
  }
});

test("buildCompactTurnPlan stays under Discord's 2000-char content cap, dropping overflow", () => {
  const manyTurns = Array.from({ length: 60 }, (_, i) => ({
    name: String(i),
    memberIds: ["u1", "u3", "u2"],
  }));
  const out = buildCompactTurnPlan(makeEvent({ turns: manyTurns }), { lang: "vi", canSeeRoom: true });
  assert.ok(out.length <= 2000, `length ${out.length} <= 2000`);
  assert.match(plain(out), /…\s*\+\d+/, "shows a dropped-turns marker");
});

test("buildCompactTurnPlan with no turns shows the empty-plan line", () => {
  const text = plain(buildCompactTurnPlan(makeEvent({ turns: [] }), { lang: "vi", canSeeRoom: true }));
  assert.ok(text.includes(t("raid-schedule.turnPlan.empty", "vi")));
});
