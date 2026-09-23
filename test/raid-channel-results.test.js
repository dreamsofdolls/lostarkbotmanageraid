"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { UI } = require("../bot/utils/raid/common/shared");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");
const {
  buildRaidChannelDmFallbackText,
  buildRaidChannelErrorHint,
  summarizeRaidChannelResults,
} = require("../bot/services/raid/channel-monitor/channel-monitor-results");

const ACT4_SOLO = { raidKey: "armoche", modeKey: "solo", label: "Act 4 Solo", minItemLevel: 1700 };
const FINAL_SOLO = { raidKey: "kazeros", modeKey: "solo", label: "Final Solo", minItemLevel: 1710 };
const FINAL_HARD = { raidKey: "kazeros", modeKey: "hard", label: "Final Hard", minItemLevel: 1730 };
const SERCA_HARD = { raidKey: "serca", modeKey: "hard", label: "Serca Hard", minItemLevel: 1730 };
const SERCA = { raidKey: "serca", modeKey: "hard", label: "Serca", minItemLevel: 1710 };

const ACCOUNTS = [{
  accountName: "Main",
  account: {
    characters: [
      { name: "Qiaoli", class: "Aeromancer", itemLevel: 1742 },
      { name: "Bori", class: "Bard", itemLevel: 1725 },
    ],
  },
}];
const DM_OFF = "_(DM bị tắt - bật \"Allow DMs from server members\" để nhận biên nhận riêng.)_";

function withClassIcons(t) {
  const saved = { Aeromancer: CLASS_EMOJI_MAP.Aeromancer, Bard: CLASS_EMOJI_MAP.Bard };
  CLASS_EMOJI_MAP.Aeromancer = "<:aero:1>";
  CLASS_EMOJI_MAP.Bard = "<:bard:2>";
  t.after(() => Object.assign(CLASS_EMOJI_MAP, saved));
}

const group = (raidMeta, results, statusType = "complete") => ({ raidMeta, statusType, effectiveGates: [], results });
const written = (name) => ({ charName: name.toLowerCase(), displayName: name, matched: true, updated: true });
const already = (name) => ({ charName: name.toLowerCase(), displayName: name, matched: true, alreadyComplete: true });

test("raid-channel result summary groups progress and error outcomes", () => {
  const summary = summarizeRaidChannelResults([
    { charName: "Done", matched: true, updated: true },
    { charName: "Already", matched: true, alreadyComplete: true },
    { charName: "AlreadyReset", matched: true, alreadyReset: true },
    { charName: "Missing", matched: false },
    { charName: "Low", matched: true, ineligibleItemLevel: 1600 },
    { charName: "Errored", error: "save failed" },
  ]);

  assert.equal(summary.hasProgress, true);
  assert.equal(summary.hasErrors, true);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.alreadyCount, 2);
  assert.deepEqual(summary.notFoundResults.map((r) => r.charName), ["Missing"]);
  assert.deepEqual(summary.ineligibleResults.map((r) => r.charName), ["Low"]);
  assert.deepEqual(summary.errorResults.map((r) => r.charName), ["Errored"]);
});

test("the DM fallback is one message for every raid of the post, names with class icons", (t) => {
  withClassIcons(t);
  const content = buildRaidChannelDmFallbackText({
    resultGroups: [group(ACT4_SOLO, [written("Qiaoli")]), group(FINAL_SOLO, [written("Qiaoli")])],
    accounts: ACCOUNTS,
    authorLang: "vi",
    UI,
    userId: "user-1",
  });

  assert.equal(content, `${UI.icons.done} <@user-1> đã ghi <:aero:1> **Qiaoli** · Act 4 Solo, Final Solo. ${DM_OFF}`);
});

test("the DM fallback joins written and already-done raids, and uses the info icon when nothing was written", (t) => {
  withClassIcons(t);
  const mixed = buildRaidChannelDmFallbackText({
    resultGroups: [group(ACT4_SOLO, [written("Qiaoli"), written("Bori")]), group(FINAL_SOLO, [written("Qiaoli"), already("Bori")])],
    accounts: ACCOUNTS,
    authorLang: "vi",
    UI,
    userId: "user-1",
  });
  const nothingNew = buildRaidChannelDmFallbackText({
    resultGroups: [group(ACT4_SOLO, [already("Qiaoli")])],
    accounts: ACCOUNTS,
    authorLang: "vi",
    UI,
    userId: "user-1",
  });

  assert.equal(
    mixed,
    `${UI.icons.done} <@user-1> đã ghi <:aero:1> **Qiaoli** · Act 4 Solo, Final Solo; <:bard:2> **Bori** · Act 4 Solo. `
      + `<:bard:2> **Bori** · Final Solo đã DONE từ trước. ${DM_OFF}`,
  );
  assert.equal(nothingNew, `${UI.icons.info} <@user-1> <:aero:1> **Qiaoli** · Act 4 Solo đã DONE từ trước. ${DM_OFF}`);
});

test("a character typed twice reads as written once in the DM fallback", (t) => {
  withClassIcons(t);
  const content = buildRaidChannelDmFallbackText({
    resultGroups: [group(ACT4_SOLO, [written("Qiaoli"), already("Qiaoli")])],
    accounts: ACCOUNTS,
    authorLang: "vi",
    UI,
    userId: "user-1",
  });

  assert.equal(content, `${UI.icons.done} <@user-1> đã ghi <:aero:1> **Qiaoli** · Act 4 Solo. ${DM_OFF}`);
});

test("the DM fallback words a reset and an already-empty raid", (t) => {
  withClassIcons(t);
  const content = buildRaidChannelDmFallbackText({
    resultGroups: [group(SERCA, [
      written("Qiaoli"),
      { charName: "bori", displayName: "Bori", matched: true, alreadyReset: true },
    ], "reset")],
    accounts: ACCOUNTS,
    authorLang: "vi",
    UI,
    userId: "user-1",
  });

  assert.equal(content, `${UI.icons.reset} <@user-1> đã reset <:aero:1> **Qiaoli** · Serca. <:bard:2> **Bori** · Serca vốn đã trống. ${DM_OFF}`);
});

test("the error hint merges every raid of a character and ends with one note", (t) => {
  withClassIcons(t);
  const low = { charName: "bori", displayName: "Bori", matched: true, updated: false, ineligibleItemLevel: 1725 };
  const content = buildRaidChannelErrorHint({
    resultGroups: [group(FINAL_HARD, [written("Qiaoli"), low]), group(SERCA_HARD, [written("Qiaoli"), low])],
    accounts: ACCOUNTS,
    authorLang: "vi",
    UI,
  });

  assert.equal(content, [
    `${UI.icons.warn} Chưa đủ iLvl: <:bard:2> **Bori** (iLvl 1725) · Final Hard (cần 1730+), Serca Hard (cần 1730+)`,
    "_(Các character hợp lệ khác trong post của bạn đã được update rồi - check DM cho chi tiết.)_",
  ].join("\n"));
});

test("the error hint lists failed writes with class icons and not-found names as code", (t) => {
  withClassIcons(t);
  const content = buildRaidChannelErrorHint({
    resultGroups: [group(SERCA_HARD, [
      { charName: "qiaoli", error: "Write conflict", matched: false, updated: false },
      { charName: "Ghost", matched: false },
    ])],
    accounts: ACCOUNTS,
    authorLang: "vi",
    UI,
  });

  assert.equal(content, [
    `${UI.icons.warn} Không tìm thấy trong roster: \`Ghost\``,
    `${UI.icons.warn} Lỗi hệ thống khi update: <:aero:1> **Qiaoli** · Serca Hard`,
    "_(Sửa lại rồi post lại nhé, tớ sẽ tự dọn hint cũ.)_",
  ].join("\n"));
  assert.equal(buildRaidChannelErrorHint({ resultGroups: [group(SERCA_HARD, [written("Qiaoli")])], accounts: ACCOUNTS, authorLang: "vi", UI }), null);
});
