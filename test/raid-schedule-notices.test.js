const test = require("node:test");
const assert = require("node:assert/strict");

const { createScheduleNoticeHelpers } = require("../bot/handlers/raid/schedule/view/notices");

class StubEmbed {
  constructor() {
    this.data = {};
  }
  setColor(value) {
    this.data.color = value;
    return this;
  }
  setAuthor(value) {
    this.data.author = value;
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

const UI = {
  colors: {
    danger: 1,
    success: 2,
    progress: 3,
    neutral: 4,
  },
};

test("raid-schedule notices map type to HUD kicker and color", () => {
  const { noticeEmbed } = createScheduleNoticeHelpers({
    EmbedBuilder: StubEmbed,
    UI,
  });

  const warn = noticeEmbed("warn", "Title", "Body");
  assert.equal(warn.data.color, UI.colors.progress);
  assert.deepEqual(warn.data.author, { name: "// HEADS UP" });
  assert.equal(warn.data.title, "Title");
  assert.equal(warn.data.description, "Body");

  const fallback = noticeEmbed("unknown", "Fallback");
  assert.equal(fallback.data.color, UI.colors.neutral);
  assert.deepEqual(fallback.data.author, { name: "// INFO" });
});

test("raid-schedule replyNotice uses followUp once interaction is deferred", async () => {
  const { replyNotice } = createScheduleNoticeHelpers({
    EmbedBuilder: StubEmbed,
    UI,
    ephemeralFlag: 64,
  });
  const calls = [];
  const interaction = {
    deferred: true,
    replied: false,
    reply: (payload) => calls.push(["reply", payload]),
    followUp: (payload) => calls.push(["followUp", payload]),
  };

  await replyNotice(interaction, "en", "info", "unknownTitle", "unknownDescription");

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "followUp");
  assert.equal(calls[0][1].flags, 64);
  assert.equal(calls[0][1].embeds[0].data.color, UI.colors.neutral);
});

test("raid-schedule editNotice clears components", async () => {
  const { editNotice } = createScheduleNoticeHelpers({
    EmbedBuilder: StubEmbed,
    UI,
  });
  let edited = null;
  await editNotice(
    { editReply: (payload) => { edited = payload; } },
    "en",
    "success",
    "unknownTitle",
    "unknownDescription"
  );

  assert.deepEqual(edited.components, []);
  assert.equal(edited.embeds[0].data.color, UI.colors.success);
});
