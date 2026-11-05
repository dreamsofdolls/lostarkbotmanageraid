"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");
const { buildRaidLogNotice, buildRevokedNotice } = require("../bot/handlers/raid/log-notices");
const { buildNoticeEmbed } = require("../bot/utils/raid/common/shared");

const URL = "https://lostark.bible/logs/zEn59i4";
const CODES = ["owner_only", "panel_busy", "stale", "invalid_selection", "expired", "busy", "invalid_source",
  "invalid_character", "roster_changed", "character_not_found", "no_logs", "logs_private", "character_mismatch",
  "rate_limited", "timeout", "unavailable", "incomplete", "too_large", "browser_crashed", "browser_unavailable",
  "invalid_url", "invalid_view", "failed"];
const kindStyle = kind => {
  const embed = buildNoticeEmbed(EmbedBuilder, { kind, title: "x" }).toJSON();
  return { color: embed.color, prefix: embed.title.slice(0, -1) };
};

// One kind per code, by the spec's kind table: a refusal by owner or privacy
// is guard, an old panel or choice is expired, Bible or capture limits are
// busy, and a capture that broke is failure.
const EXPECTED_KINDS = {
  owner_only: "guard", panel_busy: "busy", stale: "expired", invalid_selection: "expired", expired: "expired",
  busy: "busy", invalid_source: "input", invalid_character: "input", roster_changed: "expired",
  character_not_found: "empty", no_logs: "empty", logs_private: "guard", character_mismatch: "failure",
  rate_limited: "busy", timeout: "busy", unavailable: "failure", incomplete: "failure", too_large: "busy",
  browser_crashed: "failure", browser_unavailable: "failure", invalid_url: "input", invalid_view: "failure",
  failed: "failure",
};

test("each raid-log code is a notice of its own kind, with a tip and a timestamp", () => {
  assert.deepEqual(Object.keys(EXPECTED_KINDS).sort(), [...CODES].sort());
  for (const lang of ["vi", "en", "jp"]) {
    for (const code of CODES) {
      const embed = buildRaidLogNotice(code, { EmbedBuilder, lang, logUrl: URL, owner: "<@owner>" }).toJSON();
      const expected = kindStyle(EXPECTED_KINDS[code]);
      assert.ok(embed.title.startsWith(expected.prefix), `${lang}:${code} ${embed.title}`);
      assert.equal(embed.color, expected.color, `${lang}:${code}`);
      assert.ok(embed.footer?.text.startsWith("💡 "), `${lang}:${code} tip`);
      assert.ok(embed.timestamp, `${lang}:${code} timestamp`);
    }
  }
});

test("every raid-log code is a titled notice card in every language", () => {
  for (const lang of ["vi", "en", "jp"]) {
    for (const code of CODES) {
      const embed = buildRaidLogNotice(code, { EmbedBuilder, lang, logUrl: URL, owner: "<@owner>" }).toJSON();
      assert.ok(embed.title && embed.description, `${lang}:${code}`);
      assert.doesNotMatch(JSON.stringify(embed), /raid-log\.|\{\w+\}/, `${lang}:${code}`);
    }
  }
});

test("failures while opening a log link the original log; boundaries and input errors do not", () => {
  const linked = code => buildRaidLogNotice(code, { EmbedBuilder, lang: "vi", logUrl: URL }).toJSON().description.includes(`](${URL})`);
  assert.deepEqual(CODES.filter(linked), ["timeout", "unavailable", "incomplete", "too_large", "browser_crashed", "failed"]);
  assert.ok(!buildRaidLogNotice("timeout", { EmbedBuilder, lang: "vi" }).toJSON().description.includes("]("));
});

test("someone else's panel gets a guard card naming its owner; an expired one is grey", () => {
  const owner = buildRaidLogNotice("owner_only", { EmbedBuilder, lang: "vi", owner: "<@author>" }).toJSON();
  assert.equal(owner.color, kindStyle("guard").color);
  assert.ok(owner.title.startsWith(kindStyle("guard").prefix));
  assert.match(owner.description, /<@author>/);
  const expired = buildRaidLogNotice("expired", { EmbedBuilder, lang: "vi" }).toJSON();
  assert.ok(expired.title.startsWith("⌛  "));
  assert.equal(expired.color, kindStyle("expired").color);
  // Bible not answering is busy, not a red failure.
  assert.ok(buildRaidLogNotice("timeout", { EmbedBuilder, lang: "vi" }).toJSON().title.startsWith("🚦  "));
});

test("a panel whose character went private is a guard with that name; other revokes use their own card", () => {
  for (const lang of ["vi", "en", "jp"]) {
    const embed = buildRevokedNotice("logs_private", { EmbedBuilder, lang, character: "Qiylyn" }).toJSON();
    assert.match(embed.title, /Qiylyn/);
    assert.match(embed.description, /Qiylyn/);
    assert.match(embed.footer.text, /^💡 .*\/raid-log/);
    assert.equal(embed.color, kindStyle("guard").color);
  }
  const mismatch = buildRevokedNotice("character_mismatch", { EmbedBuilder, lang: "vi", character: "Qiylyn" }).toJSON();
  assert.match(mismatch.title, /Dữ liệu Bible không khớp/);
  assert.ok(mismatch.title.startsWith(kindStyle("failure").prefix));
});

test("oversized notice descriptions are clamped to the embed limit instead of throwing", () => {
  // Handlers interpolate user-controlled strings (roster names can reach
  // Discord's 6000-char option cap) into error notices; a raw setDescription
  // throws at the 4096-char description limit and 8 commands degrade to a
  // generic failure reply.
  const embed = buildNoticeEmbed(EmbedBuilder, {
    kind: "failure",
    title: "x",
    description: "x".repeat(5000),
  }).toJSON();
  assert.equal(embed.description.length, 4096);
  assert.ok(embed.description.endsWith("..."));
});

test("notice descriptions at or under the limit pass through unchanged", () => {
  assert.equal(
    buildNoticeEmbed(EmbedBuilder, { description: "short text" }).toJSON().description,
    "short text"
  );
  const exact = "y".repeat(4096);
  assert.equal(
    buildNoticeEmbed(EmbedBuilder, { description: exact }).toJSON().description,
    exact
  );
});
