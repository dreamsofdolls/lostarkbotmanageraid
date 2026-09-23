const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder } = require("discord.js");
const { INLINE_SPACER, UI } = require("../bot/utils/raid/common/shared");
const {
  createRaidChannelEmbedBuilders,
  joinIfArray,
} = require("../bot/services/raid/channel-monitor/channel-monitor-embeds");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");
const { getRaidRequirementMap } = require("../bot/domain/raid-catalog");
const { TRANSLATIONS } = require("../bot/locales");

const RAIDS = getRaidRequirementMap();
const NOW = Date.now();
const cleared = (difficulty) => ({ difficulty, completedDate: NOW });
const doneRaids = (modeKey, difficulty, raidKeys) => Object.fromEntries(
  raidKeys.map((raidKey) => [raidKey, { modeKey, G1: cleared(difficulty), G2: cleared(difficulty) }])
);
const character = (name, className, itemLevel, assignedRaids) => ({ name, class: className, itemLevel, assignedRaids });
const account = (accountName, characters) => ({ accountName, account: { characters } });
const group = (raidMeta, results, statusType = "complete") => ({ raidMeta, statusType, effectiveGates: [], results });
const written = (name) => ({ charName: name.toLowerCase(), displayName: name, matched: true, updated: true });
const already = (name) => ({ charName: name.toLowerCase(), displayName: name, matched: true, alreadyComplete: true });
// Character cards only: drops pack2Columns' spacers (roster headers stay).
const cardsOf = (embed) => (embed.fields || []).filter((field) => field.name !== INLINE_SPACER.name);

function withClassIcons(t) {
  const saved = { Aeromancer: CLASS_EMOJI_MAP.Aeromancer, Souleater: CLASS_EMOJI_MAP.Souleater, Bard: CLASS_EMOJI_MAP.Bard };
  Object.assign(CLASS_EMOJI_MAP, { Aeromancer: "<:aero:1>", Souleater: "<:soul:2>", Bard: "<:bard:3>" });
  t.after(() => Object.assign(CLASS_EMOJI_MAP, saved));
}

function receipt(params) {
  return builders().buildRaidChannelReceiptEmbed({ guildName: "Game Is Life", lang: "vi", ...params }).toJSON();
}

// The parser labels Kazeros by what was typed ("Final"); card rows use the catalog label.
const SOLO = [RAIDS.armoche_solo, { ...RAIDS.kazeros_solo, label: "Final Solo" }, RAIDS.serca_solo];
// A reset targets the raid, not a mode: resolveRaidLevelResetMeta hands over the
// normal-mode entry with the bare raid label and no item-level floor.
const RESET_SERCA = { ...RAIDS.serca_normal, label: "Serca", minItemLevel: 0 };
const soloQiaoli = () => character("Qiaoli", "Aeromancer", 1742, doneRaids("solo", "Solo", ["armoche", "kazeros", "serca"]));

function builders() {
  return createRaidChannelEmbedBuilders({ EmbedBuilder, UI });
}

test("raid-channel embed helper joins locale arrays without touching strings", () => {
  assert.equal(joinIfArray(["a", "b"]), "a\nb");
  assert.equal(joinIfArray("already text"), "already text");
});

test("one receipt covers every raid of the post", (t) => {
  withClassIcons(t);
  const embed = receipt({
    text: "act4, final, serca solo Qiaoli",
    resultGroups: SOLO.map((raidMeta) => group(raidMeta, [written("Qiaoli")])),
    accounts: [account("Qiaoli", [soloQiaoli()])],
  });
  const lines = embed.description.split("\n");

  assert.equal(embed.title, `${UI.icons.done} Raid Update`);
  assert.equal(embed.color, UI.colors.success);
  assert.equal(lines[0], "💬 `act4, final, serca solo Qiaoli`");
  assert.match(lines[1], /\*\*3\*\* raid.*\*\*1\*\* character/);
  assert.deepEqual(cardsOf(embed).map((f) => [f.name, f.value]), [[
    "<:aero:1> Qiaoli · 1742",
    [`${UI.icons.done} Act 4 Solo · 2/2`, `${UI.icons.done} Kazeros Solo · 2/2`, `${UI.icons.done} Serca Solo · 2/2`].join("\n"),
  ]]);
  assert.equal(embed.footer.text, "Server: Game Is Life");
});

test("a post with nothing new reads as nothing new", () => {
  const embed = receipt({
    text: "act4, final, serca solo Qiaoli",
    resultGroups: SOLO.map((raidMeta) => group(raidMeta, [already("Qiaoli")])),
    accounts: [account("Qiaoli", [soloQiaoli()])],
  });

  assert.equal(embed.title, `${UI.icons.info} Raid Update`);
  assert.equal(embed.color, UI.colors.neutral);
  assert.ok(TRANSLATIONS.vi["text-parser"].raidUpdateNothingNew.variants.includes(embed.description.split("\n")[1]));
  assert.ok(cardsOf(embed)[0].value.split("\n").every((row) => row.startsWith(`${UI.icons.info} `)));
});

test("mixed outcomes add tails in order and warning rows on the cards", (t) => {
  withClassIcons(t);
  const bori = { charName: "bori", displayName: "Bori", matched: true, updated: false, ineligibleItemLevel: 1725 };
  const embed = receipt({
    text: "act4, serca hard Qiaoli, Hailua, Bori, Ghost",
    resultGroups: [
      group(RAIDS.armoche_hard, [written("Qiaoli"), written("Hailua"), written("Bori"), { charName: "Ghost", matched: false }]),
      group(RAIDS.serca_hard, [written("Qiaoli"), already("Hailua"), bori, { charName: "Ghost", matched: false }]),
    ],
    accounts: [account("Main", [
      character("Qiaoli", "Aeromancer", 1742, doneRaids("hard", "Hard", ["armoche", "serca"])),
      character("Hailua", "Souleater", 1745, doneRaids("hard", "Hard", ["armoche", "serca"])),
      character("Bori", "Bard", 1725, doneRaids("hard", "Hard", ["armoche"])),
    ])],
  });
  const lines = embed.description.split("\n");
  const bOri = cardsOf(embed).find((f) => f.name.includes("Bori"));
  const hailua = cardsOf(embed).find((f) => f.name.includes("Hailua"));

  assert.equal(embed.title, `${UI.icons.warn} Raid Update`);
  assert.equal(embed.color, UI.colors.progress);
  assert.match(lines[1], /\*\*4\*\* raid.*\*\*3\*\* character/);
  assert.deepEqual(lines.slice(2), [
    `${UI.icons.info} 1 raid đã DONE từ trước, tớ để nguyên.`,
    `${UI.icons.warn} 1 raid chưa đủ iLvl nên tớ bỏ qua.`,
    `${UI.icons.warn} Không tìm thấy trong roster: \`Ghost\``,
  ]);
  assert.equal(hailua.value.split("\n")[1], `${UI.icons.info} Serca Hard · 2/2`);
  assert.equal(bOri.value.split("\n").at(-1), `${UI.icons.warn} Serca Hard · _cần 1730+_`);
});

test("a one-gate post shows the raid half done", () => {
  const qiaoli = character("Qiaoli", "Aeromancer", 1742, {
    armoche: { modeKey: "hard", G1: cleared("Hard"), G2: { difficulty: "Hard", completedDate: 0 } },
  });
  const embed = receipt({
    text: "act4 hard g1 Qiaoli",
    resultGroups: [{ ...group(RAIDS.armoche_hard, [written("Qiaoli")], "process"), effectiveGates: ["G1"] }],
    accounts: [account("Qiaoli", [qiaoli])],
  });

  assert.match(cardsOf(embed)[0].value, /Act 4 Hard · 1\/2$/);
});

test("a reset and a reset of an empty raid, matched on the raid whatever mode is stored", () => {
  const qiaoli = character("Qiaoli", "Aeromancer", 1742, { serca: { modeKey: "hard" } });
  const done = receipt({
    text: "serca reset Qiaoli",
    resultGroups: [group(RESET_SERCA, [written("Qiaoli")], "reset")],
    accounts: [account("Qiaoli", [qiaoli])],
  });
  const empty = receipt({
    text: "serca reset Qiaoli",
    resultGroups: [group(RESET_SERCA, [{ charName: "qiaoli", displayName: "Qiaoli", matched: true, alreadyReset: true }], "reset")],
    accounts: [account("Qiaoli", [qiaoli])],
  });

  assert.equal(done.title, `${UI.icons.reset} Reset Raid`);
  assert.equal(done.color, UI.colors.muted);
  assert.match(cardsOf(done)[0].value, /Serca Hard · 0\/2$/);
  assert.equal(empty.title, `${UI.icons.info} Reset Raid`);
  assert.equal(empty.color, UI.colors.muted);
  assert.ok(TRANSLATIONS.vi["text-parser"].raidResetNothing.variants.includes(empty.description.split("\n")[1]));
});

test("a reset on a character below the raid's item level still gets its row", () => {
  const alreadyEmpty = receipt({
    text: "serca reset Alt",
    resultGroups: [group(RESET_SERCA, [{ charName: "alt", displayName: "Alt", matched: true, alreadyReset: true }], "reset")],
    accounts: [account("Alt", [character("Alt", "Bard", 1700, {})])],
  });
  const reset = receipt({
    text: "serca reset Alt",
    resultGroups: [group(RESET_SERCA, [written("Alt")], "reset")],
    accounts: [account("Alt", [character("Alt", "Bard", 1600, { serca: { modeKey: "hard" } })])],
  });

  assert.equal(cardsOf(alreadyEmpty)[0].value, `${UI.icons.info} Serca`);
  assert.equal(cardsOf(reset)[0].value, `${UI.icons.reset} Serca`);
});

test("a failed write lands on its character whatever the case it was typed in", () => {
  const embed = receipt({
    text: "act4, serca hard Qiaoli, hailua",
    resultGroups: [
      group(RAIDS.armoche_hard, [written("Qiaoli"), written("Hailua")]),
      group(RAIDS.serca_hard, [written("Qiaoli"), { charName: "hailua", error: "Write conflict", matched: false, updated: false }]),
    ],
    accounts: [account("Main", [
      character("Qiaoli", "Aeromancer", 1742, doneRaids("hard", "Hard", ["armoche", "serca"])),
      character("Hailua", "Souleater", 1745, doneRaids("hard", "Hard", ["armoche"])),
    ])],
  });

  assert.match(embed.description, /\*\*3\*\* raid.*\*\*2\*\* character/);
  assert.match(embed.description, /1 raid ghi lỗi, cậu gõ lại giúp tớ nha\./);
  assert.equal(
    cardsOf(embed).find((f) => f.name.includes("Hailua")).value.split("\n").at(-1),
    `${UI.icons.warn} Serca Hard · _ghi lỗi, gõ lại nha_`,
  );
});

test("characters from two rosters get roster headers", () => {
  const embed = receipt({
    text: "act4 hard Qiaoli, Bori",
    resultGroups: [group(RAIDS.armoche_hard, [written("Qiaoli"), written("Bori")])],
    accounts: [
      account("Qiaoli", [character("Qiaoli", "Aeromancer", 1742, doneRaids("hard", "Hard", ["armoche"]))]),
      account("Borinest", [character("Bori", "Bard", 1725, doneRaids("hard", "Hard", ["armoche"]))]),
    ],
  });

  assert.deepEqual(
    embed.fields.filter((f) => f.name.startsWith(UI.icons.folder)).map((f) => f.name),
    [`${UI.icons.folder} Qiaoli (1)`, `${UI.icons.folder} Borinest (1)`],
  );
});

test("the same character typed twice counts and reads as written", () => {
  const embed = receipt({
    text: "act4 hard Qiaoli, qiaoli",
    resultGroups: [group(RAIDS.armoche_hard, [written("Qiaoli"), already("Qiaoli")])],
    accounts: [account("Qiaoli", [character("Qiaoli", "Aeromancer", 1742, doneRaids("hard", "Hard", ["armoche"]))])],
  });
  const lines = embed.description.split("\n");

  assert.equal(embed.title, `${UI.icons.done} Raid Update`);
  assert.match(lines[1], /\*\*1\*\* raid.*\*\*1\*\* character/);
  assert.deepEqual(lines.slice(2), []);
  assert.equal(cardsOf(embed).length, 1);
  assert.equal(cardsOf(embed)[0].value, `${UI.icons.done} Act 4 Hard · 2/2`);
});

test("rows fall back to raid names when the roster predates the write", () => {
  const embed = receipt({
    text: "act4, final, serca solo Qiaoli",
    resultGroups: SOLO.map((raidMeta) => group(raidMeta, [written("Qiaoli")])),
    accounts: [account("Qiaoli", [character("Qiaoli", "Aeromancer", 1742, {})])],
    afterWrite: false,
  });

  assert.equal(
    cardsOf(embed)[0].value,
    [`${UI.icons.done} Act 4 Solo`, `${UI.icons.done} Final Solo`, `${UI.icons.done} Serca Solo`].join("\n"),
  );
});

test("the receipt line stays one line inside its code span", () => {
  const text = `act4 hard \`Qiaoli\`\n${"x".repeat(300)}`;
  const embed = receipt({
    text,
    resultGroups: [group(RAIDS.armoche_hard, [written("Qiaoli")])],
    accounts: [],
  });
  const line = embed.description.split("\n")[0];

  assert.ok(line.startsWith("💬 `act4 hard 'Qiaoli' xxx"));
  assert.equal(line.length, "💬 ``".length + 200);
  assert.ok(line.endsWith("…`"));
});

test("a post past the field cap keeps every raid in the summary", () => {
  const names = Array.from({ length: 20 }, (_, i) => `Alt${i}`);
  const embed = receipt({
    text: `act4 hard ${names.join(", ")}`,
    resultGroups: [group(RAIDS.armoche_hard, names.map(written))],
    accounts: [account("Main", names.map((n) => character(n, "Bard", 1740, doneRaids("hard", "Hard", ["armoche"]))))],
  });

  assert.ok(embed.fields.length <= 25);
  assert.match(embed.description, /\*\*20\*\* raid.*\*\*20\*\* character/);
});

test("a written character the re-read no longer holds still counts but draws no card", () => {
  const embed = receipt({
    text: "act4 hard Qiaoli, Gone",
    resultGroups: [group(RAIDS.armoche_hard, [written("Qiaoli"), written("Gone")])],
    accounts: [account("Qiaoli", [character("Qiaoli", "Aeromancer", 1742, doneRaids("hard", "Hard", ["armoche"]))])],
  });

  assert.equal(cardsOf(embed).length, 1);
  assert.match(embed.description, /\*\*2\*\* raid.*\*\*2\*\* character/);
});

test("raid-channel welcome embed renders the configured onboarding field set", () => {
  const embed = builders().buildRaidChannelWelcomeEmbed("en").toJSON();

  assert.equal(embed.color, UI.colors.neutral);
  assert.ok(embed.title);
  assert.ok(embed.description);
  assert.equal(embed.fields.length, 10);
  assert.ok(embed.fields.every((field) => typeof field.name === "string" && field.name.length > 0));
  assert.ok(embed.fields.every((field) => typeof field.value === "string" && field.value.length > 0));
  assert.doesNotMatch(
    embed.fields.map((field) => `${field.name}\n${field.value}`).join("\n"),
    /rosters wearing.*👑/i
  );
});
