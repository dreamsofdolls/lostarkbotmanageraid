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
const style = type => buildNoticeEmbed(EmbedBuilder, { type, title: "x" }).toJSON();

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

test("someone else's panel gets a lock card naming its owner; an expired one is muted", () => {
  const owner = buildRaidLogNotice("owner_only", { EmbedBuilder, lang: "vi", owner: "<@author>" }).toJSON();
  assert.equal(owner.color, style("lock").color);
  assert.ok(owner.title.startsWith(style("lock").title.slice(0, -1)));
  assert.match(owner.description, /<@author>/);
  assert.equal(buildRaidLogNotice("expired", { EmbedBuilder, lang: "vi" }).toJSON().color, style("muted").color);
  assert.equal(buildRaidLogNotice("timeout", { EmbedBuilder, lang: "vi" }).toJSON().color, style("error").color);
});

test("a panel whose character went private is locked with that name; other revokes use their own card", () => {
  for (const lang of ["vi", "en", "jp"]) {
    const embed = buildRevokedNotice("logs_private", { EmbedBuilder, lang, character: "Qiylyn" }).toJSON();
    assert.match(embed.title, /Qiylyn/);
    assert.match(embed.description, /Qiylyn[\s\S]*\n-# .*\/raid-log/);
    assert.equal(embed.color, style("lock").color);
  }
  const mismatch = buildRevokedNotice("character_mismatch", { EmbedBuilder, lang: "vi", character: "Qiylyn" }).toJSON();
  assert.match(mismatch.title, /Dữ liệu Bible không khớp/);
  assert.ok(mismatch.title.startsWith(style("lock").title.slice(0, -1)));
});
