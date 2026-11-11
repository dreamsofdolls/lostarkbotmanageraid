"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder, MessageFlags } = require("discord.js");
const { buildRaidLogNotice } = require("../bot/handlers/raid/log-notices");
const { fixture, captures, control, noticeText } = require("./helpers/raid-log-fixture");

const SESSION_MS = 1000;

// Title and description the vi notice card for a refusal code carries.
const expectedNotice = code => noticeText({ embeds: [buildRaidLogNotice(code, { EmbedBuilder, lang: "vi", owner: "<@author>" })] });

// A refused click answers with one ephemeral notice and nothing else: no acknowledgement, no privacy check, no capture.
async function assertRejection(f, interaction, code) {
  const before = f.events.length;
  await f.click(interaction);
  assert.equal(f.events.length, before + 1, `${code}: only a reply`);
  const [event, payload] = f.events.at(-1);
  assert.equal(event, "reply", code);
  assert.equal(payload.flags, MessageFlags.Ephemeral, code);
  assert.equal(noticeText(payload), expectedNotice(code), code);
}

// Runs `body` while `action` is held inside its privacy check, so the panel is busy.
async function whileBusy(f, action, body) {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  f.beforeVerify = async () => { enter(); await held; };
  const working = f.click(action);
  await entered;
  try {
    await body();
  } finally {
    f.beforeVerify = null;
    finish();
    await working;
  }
}

test("the five refusal notices are distinct cards", () => {
  const codes = ["expired", "invalid_selection", "owner_only", "panel_busy", "stale"];
  assert.equal(new Set(codes.map(expectedNotice)).size, codes.length);
});

test("each refusal code answers its own ephemeral notice and leaves the panel alone", async () => {
  let now = 0;
  const f = fixture({ sessionMs: SESSION_MS, now: () => now });
  await f.run();
  const before = JSON.stringify(f.payload);
  const captured = captures(f).length;

  // No session: nothing else can be read from it.
  await assertRejection(f, f.owner("tab_next", undefined, { customId: "raid-log:missing:0:tab_next" }), "expired");
  for (const overrides of [{ guildId: "other" }, { channelId: "other" }, { message: { id: "other" } }, { message: undefined }]) {
    await assertRejection(f, f.owner("tab_next", undefined, overrides), "invalid_selection");
  }
  await assertRejection(f, f.component("tab_next"), "owner_only");
  assert.equal(JSON.stringify(f.payload), before);
  assert.equal(captures(f).length, captured);

  // An older card of the same panel is stale once another action moved the revision.
  const old = f.owner("tab_next");
  await f.click(f.owner("bracketed"));
  await assertRejection(f, old, "stale");

  now = SESSION_MS;
  await assertRejection(f, f.owner("tab_next"), "expired");
  assert.equal(captures(f).length, captured + 1);
});

test("a busy panel refuses the owner as busy and others as not theirs, whatever the revision", async () => {
  const f = fixture();
  await f.run();
  const old = f.owner("tab_next");
  await f.click(f.owner("bracketed"));
  const held = f.owner("tab_next");
  const mine = f.owner("tab_next");
  const other = f.component("tab_next");

  await whileBusy(f, held, async () => {
    await assertRejection(f, mine, "panel_busy");
    await assertRejection(f, other, "owner_only");
    await assertRejection(f, old, "panel_busy");
  });
  assert.equal(captures(f).length, 3);
  assert.equal(control(f, "tab_label").label, "Party Buffs · 2/12");
});

test("when several refusals apply the first in order wins", async () => {
  let now = 0;
  const f = fixture({ sessionMs: SESSION_MS, now: () => now });
  await f.run();
  const old = f.owner("tab_next");
  await f.click(f.owner("bracketed"));

  // Wrong user, stale revision: the user check comes first.
  await assertRejection(f, f.component("tab_next", undefined, { customId: old.customId }), "owner_only");
  // Wrong channel and wrong user: the location check comes first.
  await assertRejection(f, f.component("tab_next", undefined, { channelId: "other" }), "invalid_selection");
  // Expired, wrong channel and wrong user: expiry comes first.
  now = SESSION_MS;
  await assertRejection(f, f.component("tab_next", undefined, { channelId: "other" }), "expired");
  await assertRejection(f, f.component("tab_next"), "expired");
});

test("a click that passes every check runs its action, up to the last tick before expiry", async () => {
  let now = 0;
  const f = fixture({ sessionMs: SESSION_MS, now: () => now });
  await f.run();
  now = SESSION_MS - 1;
  f.events.length = 0;
  await f.click(f.owner("tab_next"));
  assert.deepEqual(f.events.slice(0, 3), ["ack-update", "edit", "verify"]);
  assert.equal(captures(f).length, 1);
  assert.equal(control(f, "tab_label").label, "Party Buffs · 2/12");
});
