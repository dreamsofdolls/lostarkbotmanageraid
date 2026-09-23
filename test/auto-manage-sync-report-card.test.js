"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");
const { createAutoManageReportEmbeds } = require("../bot/services/auto-manage/reports/embeds");
const { UI } = require("../bot/utils/raid/common/shared");
const { t } = require("../bot/services/i18n");

const NOW = Date.now();
const COOLDOWN_MS = 10 * 60 * 1000;
const DONE = { difficulty: "Hard", completedDate: 200 };
const OPEN = { difficulty: "Hard", completedDate: 0 };

const { buildAutoManageSyncReportEmbed } = createAutoManageReportEmbeds({
  EmbedBuilder,
  UI,
  getAutoManageCooldownMs: () => COOLDOWN_MS,
});

const character = (name, className, assignedRaids = {}) => ({
  name, class: className, itemLevel: 1750, isGoldEarner: true, assignedRaids,
});
const userDoc = (accounts, lastSyncAt = NOW) => ({
  discordId: "owner", lastAutoManageSyncAt: lastSyncAt, lastAutoManageAttemptAt: NOW, accounts,
});
const gates = (raidKey, modeKey, ...names) => names.map((gate) => ({ raidKey, modeKey, gate }));
const cardsOf = (embed) => (embed.fields || []).filter((field) => field.name !== "​");

const CLAUSEDUK = character("Clauseduk", "Berserker", {
  kazeros: { modeKey: "hard", G1: DONE, G2: DONE },
  serca: { modeKey: "nightmare", G1: { difficulty: "Nightmare", completedDate: 200 } },
});
const DUSKFOX = character("Duskfox", "Sorceress", { kazeros: { modeKey: "hard", G1: DONE, G2: OPEN } });
const KANNA = character("Kanna", "Artist");
const CLAUSEDUK_APPLIED = [...gates("kazeros", "hard", "G1", "G2"), ...gates("serca", "nightmare", "G1")];

// Messages as the Bible client, the limiter and fetch() produce them.
const PRIVATE_LOGS = 'Bible logs API returned HTTP 403 - {"error":"Logs not enabled"}';
const BACKOFF = "LostArk Bible HTTP 429 - global backoff active for 45s";
const blockedPage = (name) => `Bible roster page returned HTTP 403 for "${name}"`;
const missing = (name) => `lostark.bible has no character "${name}"`;
const label = (kind) => t(`common.bibleError.${kind}`, "en");

test("a clean sync shows the changed characters in the /raid-status grammar", () => {
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 4,
    perChar: [
      { accountName: "Clauseduk", charName: "Clauseduk", applied: CLAUSEDUK_APPLIED, error: null },
      { accountName: "Clauseduk", charName: "Duskfox", applied: gates("kazeros", "hard", "G1"), error: null },
    ],
  }, "en", { userDoc: userDoc([{ accountName: "Clauseduk", characters: [CLAUSEDUK, DUSKFOX] }]) }).toJSON();
  const cards = cardsOf(embed);

  assert.equal(embed.title, `${UI.icons.done} ${t("raid-auto-manage.syncReport.title", "en")}`);
  assert.equal(embed.color, UI.colors.success);
  assert.equal(cards.length, 2);
  assert.match(cards[0].name, /Clauseduk · 1750$/u);
  assert.equal(cards[0].value, "🟢 Kazeros Hard · 2/2\n🟢 Serca Nightmare · 1/1");
  assert.equal(cards[1].value, "🟡 Kazeros Hard · 1/2");
  assert.equal(embed.fields.some((field) => field.name.startsWith(UI.icons.folder)), false);
  assert.match(embed.description, /\*\*4\*\*/u);
  assert.match(embed.description, new RegExp(`<t:${Math.floor((NOW + COOLDOWN_MS) / 1000)}:R>`, "u"));
  assert.equal(embed.footer.text, "🟢 2 done · 🟡 1 partial · ⚪ 3 pending");
});

test("a failed character is a card in its own roster, and two rosters get headers", () => {
  const doc = userDoc([
    { accountName: "Clauseduk", characters: [CLAUSEDUK] },
    { accountName: "Ainslinn", characters: [KANNA, character("Sora", "Bard")] },
  ]);
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 3,
    perChar: [
      { accountName: "Clauseduk", charName: "Clauseduk", applied: CLAUSEDUK_APPLIED, error: null },
      { accountName: "Ainslinn", charName: "Kanna", applied: [], error: PRIVATE_LOGS },
      { accountName: "Ainslinn", charName: "Sora", applied: [], error: blockedPage("Sora") },
    ],
  }, "en", { userDoc: doc }).toJSON();
  const names = embed.fields.map((field) => field.name);
  const kanna = embed.fields.find((field) => field.name.endsWith("Kanna · 1750"));
  const sora = embed.fields.find((field) => field.name.endsWith("Sora · 1750"));

  assert.equal(embed.color, UI.colors.progress);
  assert.ok(embed.title.startsWith(UI.icons.warn));
  assert.deepEqual(names.filter((name) => name.startsWith(UI.icons.folder)),
    [`${UI.icons.folder} Clauseduk (1)`, `${UI.icons.folder} Ainslinn (2)`]);
  assert.equal(kanna.value, `${UI.icons.warn} _${label("publicLogOff")}_`);
  assert.equal(sora.value, `${UI.icons.warn} _${label("blocked")}_`);
  assert.ok(names.indexOf(kanna.name) > names.indexOf(`${UI.icons.folder} Ainslinn (2)`));
});

test("a missing character and a rate limit get labels, an unknown error keeps its text", () => {
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 3,
    perChar: [
      { accountName: "Roster", charName: "Clauseduk", applied: CLAUSEDUK_APPLIED, error: null },
      { accountName: "Roster", charName: "Kanna", applied: [], error: missing("Kanna") },
      { accountName: "Roster", charName: "Duskfox", applied: [], error: BACKOFF },
    ],
  }, "en", { userDoc: userDoc([{ accountName: "Roster", characters: [CLAUSEDUK, KANNA, DUSKFOX] }]) }).toJSON();
  const valueOf = (name) => embed.fields.find((field) => field.name.endsWith(`${name} · 1750`)).value;

  assert.equal(valueOf("Kanna"), `${UI.icons.warn} _${label("notFound")}_`);
  assert.equal(valueOf("Duskfox"), `${UI.icons.warn} _${label("rateLimit")}_`);

  const unknown = buildAutoManageSyncReportEmbed({
    appliedTotal: 0,
    perChar: [
      { accountName: "Roster", charName: "Clauseduk", applied: [], error: null },
      { accountName: "Roster", charName: "Kanna", applied: [], error: "fetch failed" },
    ],
  }, "en", { userDoc: userDoc([{ accountName: "Roster", characters: [CLAUSEDUK, KANNA] }]) }).toJSON();
  assert.equal(cardsOf(unknown)[0].value, `${UI.icons.warn} \`fetch failed\``);
});

test("no new gates with some failures shows only the failed characters", () => {
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 0,
    perChar: [
      { accountName: "Roster", charName: "Clauseduk", applied: [], error: null },
      { accountName: "Roster", charName: "Kanna", applied: [], error: "Logs not enabled" },
    ],
  }, "en", { userDoc: userDoc([{ accountName: "Roster", characters: [CLAUSEDUK, KANNA] }]) }).toJSON();
  const cards = cardsOf(embed);

  assert.equal(embed.color, UI.colors.progress);
  assert.equal(cards.length, 1);
  assert.match(cards[0].name, /Kanna · 1750$/u);
});

test("when every character fails, no cards are drawn and the reasons are grouped", () => {
  const alts = Array.from({ length: 12 }, (_, index) => `Alt${index}`);
  const doc = userDoc(
    [{ accountName: "Roster", characters: [KANNA, ...["Sora", "Mika", "Aki", ...alts].map((name) => character(name, "Bard"))] }],
    NOW - 3_600_000,
  );
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 0,
    perChar: [
      { accountName: "Roster", charName: "Aki", applied: [], error: BACKOFF },
      { accountName: "Roster", charName: "Mika", applied: [], error: blockedPage("Mika") },
      { accountName: "Roster", charName: "Sora", applied: [], error: missing("Sora") },
      { accountName: "Roster", charName: "Kanna", applied: [], error: PRIVATE_LOGS },
      ...alts.map((name) => ({ accountName: "Roster", charName: name, applied: [], error: "fetch failed" })),
    ],
  }, "en", { userDoc: doc }).toJSON();
  const reasonLines = [
    `**${label("publicLogOff")}:** **Kanna**`,
    `**${label("notFound")}:** **Sora**`,
    `**${label("blocked")}:** **Mika**`,
    `**${label("rateLimit")}:** **Aki**`,
    `**${t("raid-auto-manage.syncReport.otherError", "en")}:** **Alt0**`,
  ];

  assert.equal(embed.color, UI.colors.danger);
  assert.equal(embed.fields, undefined);
  const positions = reasonLines.map((line) => embed.description.indexOf(line));
  assert.ok(positions.every((position) => position >= 0), `missing reason line in:\n${embed.description}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(embed.description.includes("**Alt9** … and 2 more · `fetch failed`"));
  assert.equal(embed.description.includes(`**Mika** · \``), false);
  assert.ok(embed.description.includes(`<t:${Math.floor((NOW - 3_600_000) / 1000)}:R>`));
});

test("a sync with nothing new is neutral and has no cards", () => {
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 0,
    perChar: [{ accountName: "Roster", charName: "Clauseduk", applied: [], error: null }],
  }, "en", { userDoc: userDoc([{ accountName: "Roster", characters: [CLAUSEDUK] }]) }).toJSON();

  assert.equal(embed.color, UI.colors.neutral);
  assert.ok(embed.title.startsWith(UI.icons.info));
  assert.equal(embed.fields, undefined);
});

test("a sync that changes many characters stays within 25 fields", () => {
  const characters = Array.from({ length: 20 }, (_, index) =>
    character(`Alt${index}`, "Bard", { kazeros: { modeKey: "hard", G1: DONE, G2: OPEN } }));
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 20,
    perChar: characters.map((c) => ({ accountName: "Roster", charName: c.name, applied: gates("kazeros", "hard", "G1"), error: null })),
  }, "en", { userDoc: userDoc([{ accountName: "Roster", characters }]) }).toJSON();

  assert.ok(embed.fields.length <= 25);
});

test("action:on title text keeps the outcome icon", () => {
  const titleText = t("raid-auto-manage.enable.initialSyncNothingTitle", "en");
  const embed = buildAutoManageSyncReportEmbed({
    appliedTotal: 0,
    perChar: [{ accountName: "Roster", charName: "Kanna", applied: [], error: "Logs not enabled" }],
  }, "en", { userDoc: userDoc([{ accountName: "Roster", characters: [KANNA] }]), titleText }).toJSON();

  assert.equal(embed.title, `${UI.icons.warn} ${titleText}`);
  assert.equal(embed.color, UI.colors.danger);
});
