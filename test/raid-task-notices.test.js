"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidTaskNoticeHelpers,
  viewOnlyShareNotice,
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

test("raid-task view-only share notice includes owner label", () => {
  const notice = viewOnlyShareNotice({ ownerLabel: "Owner One" }, "en");

  assert.equal(notice.type, "error");
  assert.equal(notice.title, "Share is view-only");
  assert.match(notice.description, /Owner One/);
});

test("raid-task view-only share notice falls back when owner label is missing", () => {
  const notice = viewOnlyShareNotice({}, "en");

  assert.match(notice.description, /\(unknown\)/);
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
