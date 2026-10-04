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

test("a slow Discord edit cannot overwrite the newer page after it finishes", async () => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const edits = [];
  let page = "Alpha", active = 0, peak = 0;
  const redraw = createStatusRedraw({
    interaction: { editReply: async payload => {
      peak = Math.max(peak, ++active);
      if (payload.embeds[0].card === "Alpha") { enter(); await held; }
      edits.push(payload);
      active--;
    } },
    buildEmbedAndCanvas: async () => ({ embeds: [{ card: page }] }),
    buildComponents: disabled => [{ controls: page, disabled }],
    isSessionEnded: () => false,
  });
  const first = redraw();
  await entered;
  page = "Bravo";
  const second = redraw();
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.equal(edits.at(-1).embeds[0].card, "Bravo");
  for (const edit of edits) assert.equal(edit.embeds[0].card, edit.components[0].controls);
});

function heldDiscordFixture({ failFirst = false } = {}) {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const edits = [], session = { page: "initial" };
  const redraw = createStatusRedraw({
    interaction: { editReply: async payload => {
      if (payload.embeds[0].card === "initial") {
        enter(); await held;
        if (failFirst) throw new Error("Discord unavailable");
      }
      edits.push(payload);
    } },
    buildEmbedAndCanvas: async () => ({ embeds: [{ card: session.page }] }),
    buildComponents: disabled => [{ controls: session.page, disabled }],
    isSessionEnded: () => false,
  });
  return { redraw, entered, finish, edits, session };
}

test("a burst retains only the newest waiting Discord payload and promptly releases the others", async () => {
  const f = heldDiscordFixture();
  const first = f.redraw();
  await f.entered;
  const requests = [], settled = [];
  for (let i = 0; i < 128; i++) {
    f.session.page = `page-${i}`;
    requests.push(f.redraw().then(result => { settled[i] = result; return result; }));
    await new Promise(resolve => setImmediate(resolve));
  }
  try {
    assert.deepEqual(settled.slice(0, 127), Array(127).fill(false));
    assert.equal(settled[127], undefined);
  } finally { f.finish(); }
  await first;
  const results = await Promise.all(requests);
  assert.equal(results.at(-1), true);
  assert.deepEqual(f.edits.map(payload => payload.embeds[0].card), ["initial", "page-127"]);
});

test("a failed Discord edit releases the slot for the latest payload and later redraws", async () => {
  const f = heldDiscordFixture({ failFirst: true });
  const first = assert.rejects(f.redraw(), /Discord unavailable/);
  await f.entered;
  f.session.page = "recovered";
  const next = f.redraw();
  await new Promise(resolve => setImmediate(resolve));
  f.finish();
  await first;
  assert.equal(await next, true);
  f.session.page = "later";
  assert.equal(await f.redraw(), true);
  assert.deepEqual(f.edits.map(payload => payload.embeds[0].card), ["recovered", "later"]);
});

test("expiry supersedes a waiting replacement prompt and prevents later writes", async () => {
  const f = heldDiscordFixture();
  const first = f.redraw();
  await f.entered;
  const prompt = f.redraw.show({ embeds: [{ card: "replacement prompt" }], components: [{ disabled: false }] });
  const expired = { embeds: [{ card: "expired" }], components: [{ disabled: true }], attachments: [] };
  const last = f.redraw.finish(expired);
  assert.equal(f.redraw.finish({}), last, "expiry is written once");
  assert.equal(await prompt, false);
  assert.equal(await f.redraw(), false);
  assert.equal(await f.redraw.show({}), false);
  f.finish();
  await first;
  assert.equal(await last, true);
  assert.deepEqual(f.edits.map(payload => payload.embeds[0].card), ["initial", "expired"]);
});
