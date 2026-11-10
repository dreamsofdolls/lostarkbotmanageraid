"use strict";

// B notices on /raid-set, /raid-bg and /raid-share.

process.env.RAID_MANAGER_ID = "manager-1";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");

const { createRaidSetResultResponder } = require("../bot/handlers/raid/set/command-result");
const { createRaidShareCommand } = require("../bot/handlers/raid/share");
const { RaidBgError } = require("../bot/handlers/raid/bg/image-pipeline");
const { CLASS_EMOJI_MAP } = require("../bot/models/Class");
const { buildNoticeEmbed, UI } = require("../bot/utils/raid/common/shared");
const { clearUserLanguageCache, t, tPick } = require("../bot/services/i18n");

const icon = (kind) => buildNoticeEmbed(EmbedBuilder, { kind, title: "x" }).toJSON().title.slice(0, -1);
const render = (entry) => (entry?.toJSON ? entry.toJSON() : buildNoticeEmbed(EmbedBuilder, entry).toJSON());
const detailName = t("common.fields.details", "vi");

test("raid-set with an unknown roster uses the shared not-found copy", async () => {
  const notices = [];
  const { replyRosterOwnerFailure } = createRaidSetResultResponder({ EmbedBuilder, UI, t: tPick });
  await replyRosterOwnerFailure({
    replySetNotice: async (notice) => { notices.push(notice); },
    resolvedOwner: null, lang: "vi", rosterName: "Vencone",
  });
  assert.equal(notices[0].kind, "empty");
  assert.equal(notices[0].title, t("common.notice.rosterNotFoundTitle", "vi"));
  assert.match(notices[0].description, /Vencone/);
});

test("raid-set already-done card is input from the helper, with the class icon", async () => {
  const saved = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = "<:bard:9>";
  try {
    const sent = [];
    const { replyRaidSetResult } = createRaidSetResultResponder({ EmbedBuilder, UI, t: tPick });
    await replyRaidSetResult({
      replySetNotice: async (notice) => { sent.push(notice); },
      replySetEmbed: async (embed) => { sent.push(embed); },
      result: { matched: true, alreadyComplete: true, displayName: "Crimsonjudgment", displayClass: "Bard" },
      lang: "vi", rosterName: "Vencone", characterName: "crimsonjudgment",
      localizedRaid: "Act 4 Hard", effectiveGate: "",
    });
    assert.equal(sent.length, 1);
    const card = render(sent[0]);
    assert.ok(card.title.startsWith(icon("input")), card.title);
    assert.match(card.description, /<:bard:9> \*\*Crimsonjudgment\*\*/u);
    assert.ok(card.timestamp);
    assert.ok(card.footer?.text.startsWith("💡 "));
  } finally {
    CLASS_EMOJI_MAP.Bard = saved;
  }
});

test("raid-set result sends one notice per outcome and the first outcome that applies wins", async () => {
  // Echoes the key and its vars, so a notice shows which branch built it.
  const echo = (key, lang, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  const { replyRaidSetResult } = createRaidSetResultResponder({ EmbedBuilder, UI, t: echo });
  const run = async (result, extra = {}) => {
    const sent = [];
    await replyRaidSetResult({
      replySetNotice: async (notice, options) => { sent.push({ notice, options }); },
      replySetEmbed: async () => { sent.push({ embed: true }); },
      result, lang: "vi", rosterName: "Vencone", characterName: "crimsonjudgment",
      raidMeta: { minItemLevel: 1720 }, localizedRaid: "Act 4 Hard", effectiveGate: "G2",
      targetDiscordId: "target-1", ...extra,
    });
    assert.equal(sent.length, 1, JSON.stringify(result));
    return sent[0];
  };

  const noRoster = await run({ noRoster: true, authLost: true });
  assert.equal(noRoster.notice.kind, "empty");
  assert.doesNotMatch(noRoster.notice.title, /^raid-set\./);
  assert.match((await run({ noRoster: true }, { actingForOther: true })).notice.description,
    /^raid-set\.roster\.deletedForOtherDescription .*"target":"target-1"/);

  const authLost = await run({ authLost: true, matched: false });
  assert.equal(authLost.notice.title, "raid-set.roster.authLostTitle");
  assert.deepEqual(authLost.options, { allowedMentions: { parse: [] } });

  assert.match((await run({ matched: false, alreadyComplete: true })).notice.description,
    /^raid-set\.character\.notFoundDescription .*"characterName":"crimsonjudgment"/);
  assert.match((await run({ matched: true, alreadyComplete: true, alreadyReset: true })).notice.description,
    /^raid-set\.already\.completeDescription .*"scope":"Act 4 Hard · G2"/);
  assert.equal((await run({ matched: true, alreadyReset: true })).notice.title, "raid-set.already.resetTitle");
  assert.match((await run({ matched: true, updated: false, ineligibleItemLevel: 1700 })).notice.description,
    /^raid-set\.character\.notEligibleDescription .*"itemLevel":1700,"minItemLevel":1720/);
});

test("raid-bg storage failure is failure with the detail field and no typed glyph", () => {
  const { buildSaveFailedNotice } = require("../bot/handlers/raid/bg/notices");
  const card = render(buildSaveFailedNotice(new Error("E11000 duplicate key"), "vi"));
  assert.ok(card.title.startsWith(icon("failure")), card.title);
  assert.doesNotMatch(card.title.slice(icon("failure").length), /❌/);
  assert.doesNotMatch(card.description, /E11000/);
  assert.match(card.fields.find((field) => field.name === detailName)?.value || "", /E11000 duplicate key/);
});

test("raid-bg image rejection is input with the decoder message in the detail field", () => {
  const { buildUploadErrorNotice } = require("../bot/handlers/raid/bg/notices");
  const err = new RaidBgError("raidBg.errors.decodeFailed", { message: "Unsupported marker 0xffc2" });
  const card = render(buildUploadErrorNotice(err, "vi"));
  assert.ok(card.title.startsWith(icon("input")), card.title);
  assert.doesNotMatch(card.description, /0xffc2/);
  assert.match(card.fields.find((field) => field.name === detailName)?.value || "", /Unsupported marker 0xffc2/);
  // A download failure is not a validation problem.
  const download = render(buildUploadErrorNotice(new RaidBgError("raidBg.errors.downloadFailed", { status: 502 }), "vi"));
  assert.ok(download.title.startsWith(icon("failure")), download.title);
});

function shareInteraction({ userId, sub }) {
  const replies = [];
  return {
    replies,
    user: { id: userId },
    options: { getSubcommand: () => sub },
    reply: async (payload) => { replies.push(payload); },
  };
}

async function withUserLanguage(run) {
  const User = require("../bot/models/user");
  const original = User.findOne;
  User.findOne = () => ({ lean: async () => ({ language: "vi" }), select() { return this; } });
  clearUserLanguageCache();
  try {
    await run();
  } finally {
    User.findOne = original;
  }
}

test("raid-share manager-only refusal is guard with who can use it", async () => {
  await withUserLanguage(async () => {
    const { handleRaidShareCommand } = createRaidShareCommand({ EmbedBuilder, UI });
    const interaction = shareInteraction({ userId: "member-1", sub: "grant" });
    await handleRaidShareCommand(interaction);
    const card = render(interaction.replies[0].embeds[0]);
    assert.ok(card.title.startsWith(icon("guard")), card.title);
    assert.ok(card.fields.some((field) => field.name.startsWith("👥")));
  });
});

test("raid-share unknown subcommand reads from the locales", async () => {
  await withUserLanguage(async () => {
    const { handleRaidShareCommand } = createRaidShareCommand({ EmbedBuilder, UI });
    const interaction = shareInteraction({ userId: "manager-1", sub: "bogus" });
    await handleRaidShareCommand(interaction);
    const card = render(interaction.replies[0].embeds[0]);
    assert.equal(card.title, `${icon("expired")}${t("share.unknownSubcommandTitle", "vi")}`);
    assert.doesNotMatch(card.title, /Unknown subcommand/);
  });
});
