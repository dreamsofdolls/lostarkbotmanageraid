"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStatusComponentRouteHandlers } = require("../bot/handlers/raid-status/components/component-handlers");

function viewFixture(refreshLocalSyncSnapshot) {
  const session = { currentView: "raid", localSyncSnapshot: null };
  const handlers = createStatusComponentRouteHandlers({
    session, interaction: { editReply: async () => {} },
    buildEmbedAndCanvas: async () => ({}), buildComponents: () => [], refreshLocalSyncSnapshot,
  });
  return { session, select: value => handlers.viewToggle({ values: [value] }) };
}

test("a slow Local Sync view cannot override a newer raid, gold or task selection", async () => {
  for (const view of ["raid", "gold", "task"]) {
    let finish;
    const held = new Promise(resolve => { finish = resolve; });
    const { session, select } = viewFixture(() => held);
    const slow = select("sync");
    await select(view);
    finish({ job: { jobId: "old" } });
    const result = await slow;
    assert.equal(session.currentView, view);
    assert.equal(session.localSyncSnapshot, null);
    assert.equal(result.redraw, false);
  }
});

test("overlapping Local Sync selections keep the newer preview instead of its late predecessor", async () => {
  let finish, reads = 0;
  const held = new Promise(resolve => { finish = resolve; });
  const fresh = { job: { jobId: "new" } };
  const { session, select } = viewFixture(() => ++reads === 1 ? held : Promise.resolve(fresh));
  const slow = select("sync");
  await select("sync");
  finish({ job: { jobId: "old" } });
  await slow;
  assert.equal(session.currentView, "sync");
  assert.equal(session.localSyncSnapshot, fresh);
});
