"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createStatusRedraw } = require("../bot/handlers/raid-status/view/redraw");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A session whose card and controls both name the page they were built for.
function fixture({ backgroundMs = () => 0 } = {}) {
  const edits = [];
  const session = { page: "Alpha", ended: false };
  const redraw = createStatusRedraw({
    interaction: { editReply: async (payload) => { edits.push(payload); } },
    buildEmbedAndCanvas: async () => {
      const embeds = [{ card: session.page }];
      await sleep(backgroundMs(session.page));
      return { embeds };
    },
    buildComponents: (disabled) => [{ controls: session.page, disabled }],
    isSessionEnded: () => session.ended,
  });
  return { edits, session, redraw };
}

test("a redraw builds its card and controls from the same moment", async () => {
  const { edits, session, redraw } = fixture({ backgroundMs: () => 20 });
  const drawn = redraw();
  session.page = "Bravo";
  assert.equal(await drawn, true);
  assert.deepEqual(edits, [{ embeds: [{ card: "Alpha" }], components: [{ controls: "Alpha", disabled: false }] }]);
});

test("a redraw overtaken by a newer one is dropped", async () => {
  const { edits, session, redraw } = fixture({ backgroundMs: (page) => (page === "Bravo" ? 40 : 5) });
  session.page = "Bravo";
  const slow = redraw();
  await sleep(5);
  session.page = "Charlie";
  const fast = redraw();

  assert.deepEqual(await Promise.all([slow, fast]), [false, true]);
  assert.deepEqual(edits.map((edit) => edit.embeds[0].card), ["Charlie"]);
});

test("a redraw that finishes after the session ended is dropped", async () => {
  const { edits, session, redraw } = fixture({ backgroundMs: () => 20 });
  const pending = redraw();
  session.ended = true;
  assert.equal(await pending, false);
  assert.deepEqual(edits, []);
});

test("a failed edit rejects so the caller can tell the user", async () => {
  const redraw = createStatusRedraw({
    interaction: { editReply: async () => { throw new Error("Unknown Message"); } },
    buildEmbedAndCanvas: async () => ({ embeds: [{}] }),
    buildComponents: () => [],
    isSessionEnded: () => false,
  });
  await assert.rejects(redraw(), /Unknown Message/);
});
