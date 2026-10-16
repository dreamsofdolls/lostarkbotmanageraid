"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildShareRefusalNotice,
  createRaidTaskNoticeHelpers,
} = require("../bot/handlers/raid/task/notices");

class FakeEmbedBuilder {
  constructor() {
    this.data = {};
  }

  setColor(value) {
    this.data.color = value;
    return this;
  }

  setTitle(value) {
    this.data.title = value;
    return this;
  }

  setDescription(value) {
    this.data.description = value;
    return this;
  }
}

// Embed titles start with the notice icon.
const withoutIcon = (title) => title.slice(title.indexOf(" ") + 1);

test("raid-task view-only share notice includes owner label", () => {
  const notice = buildShareRefusalNotice("viewOnly", { ownerLabel: "Owner One" }, "en");

  assert.equal(notice.type, "error");
  assert.equal(notice.title, "Share is view-only");
  assert.match(notice.description, /Owner One/);
});

test("raid-task view-only share notice falls back when owner label is missing", () => {
  const notice = buildShareRefusalNotice("viewOnly", {}, "en");

  assert.match(notice.description, /\(unknown\)/);
});

test("raid-task revoked share notice includes owner label", () => {
  const notice = buildShareRefusalNotice("revoked", { ownerLabel: "Owner One" }, "en");

  assert.equal(notice.type, "error");
  assert.equal(notice.title, "Share removed");
  assert.match(notice.description, /Owner One/);
});

test("raid-task view-only notice helpers answer without running the share lookup", async () => {
  const lookups = [];
  const titles = [];
  const helpers = createRaidTaskNoticeHelpers({
    EmbedBuilder: FakeEmbedBuilder,
    getAccessibleAccounts: async (viewerId, options) => {
      lookups.push([viewerId, options]);
      return [];
    },
  });
  const interaction = {
    user: { id: "viewer" },
    reply: async (payload) => titles.push(payload.embeds[0].data.title),
    editReply: async (payload) => titles.push(payload.embeds[0].data.title),
  };
  const target = { discordId: "owner", ownerLabel: "Owner One" };

  await helpers.replyViewOnlyShareNotice(interaction, target, "en");
  await helpers.editViewOnlyShareNotice(interaction, target, "en");

  assert.deepEqual(titles.map(withoutIcon), ["Share is view-only", "Share is view-only"]);
  assert.deepEqual(lookups, []);
});

test("raid-task share refusal says view-only while the owner still shares and removed once nothing is shared", async () => {
  const lookups = [];
  const refusals = [];
  for (const shares of [[{ ownerDiscordId: "owner" }], [{ ownerDiscordId: "someone-else" }], []]) {
    const helpers = createRaidTaskNoticeHelpers({
      EmbedBuilder: FakeEmbedBuilder,
      getAccessibleAccounts: async (viewerId, options) => {
        lookups.push([viewerId, options]);
        return shares;
      },
    });
    await helpers.replyShareRefusalNotice(
      { user: { id: "viewer" }, reply: async (payload) => refusals.push(payload.embeds[0].data.title) },
      { discordId: "owner", ownerLabel: "Owner One" },
      "en"
    );
  }

  assert.deepEqual(refusals.map(withoutIcon), ["Share is view-only", "Share removed", "Share removed"]);
  assert.deepEqual(lookups, Array(3).fill(["viewer", { includeOwn: false }]));
});

test("raid-task share refusal says view-only and warns once when the share lookup fails", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const helpers = createRaidTaskNoticeHelpers({
    EmbedBuilder: FakeEmbedBuilder,
    getAccessibleAccounts: async () => { throw new Error("share lookup down"); },
  });
  const edits = [];

  await helpers.editShareRefusalNotice(
    { user: { id: "viewer" }, editReply: async (payload) => edits.push(payload) },
    { discordId: "owner", ownerLabel: "Owner One" },
    "en"
  );

  assert.equal(edits.length, 1);
  assert.equal(withoutIcon(edits[0].embeds[0].data.title), "Share is view-only");
  assert.deepEqual(edits[0].components, []);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments.join(" "), /share lookup failed.*share lookup down/);
});

test("raid-task notice helpers wrap reply and update payloads", async () => {
  const helpers = createRaidTaskNoticeHelpers({
    EmbedBuilder: FakeEmbedBuilder,
  });
  const replies = [];
  const updates = [];
  const edits = [];
  const interaction = {
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    update: async (payload) => {
      updates.push(payload);
      return payload;
    },
    editReply: async (payload) => {
      edits.push(payload);
      return payload;
    },
  };

  await helpers.replyTaskNotice(interaction, {
    type: "success",
    title: "Saved",
    description: "Task registered",
  });
  await helpers.updateTaskNotice(interaction, {
    type: "warn",
    title: "Check",
    description: "Task needs attention",
  });
  await helpers.editTaskNotice(interaction, {
    type: "success",
    title: "Finished",
    description: "Deferred task action completed",
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
  assert.equal(replies[0].embeds.length, 1);
  assert.match(replies[0].embeds[0].data.title, /Saved/);
  assert.equal(replies[0].embeds[0].data.description, "Task registered");

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].components, []);
  assert.equal(updates[0].embeds.length, 1);
  assert.match(updates[0].embeds[0].data.title, /Check/);
  assert.equal(updates[0].embeds[0].data.description, "Task needs attention");

  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].components, []);
  assert.match(edits[0].embeds[0].data.title, /Finished/);
});
