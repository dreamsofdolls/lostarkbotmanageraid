const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildManualSyncFollowupPayload,
} = require("../bot/handlers/raid-status/sync/sync-followup");

function fakeT(key, lang, vars = {}) {
  const suffix = vars && Object.keys(vars).length
    ? ` ${JSON.stringify(vars)}`
    : "";
  return `${lang}:${key}${suffix}`;
}

test("raid-status manual sync followup maps applied outcome to success copy", () => {
  const payload = buildManualSyncFollowupPayload(
    { outcome: "applied", newGatesApplied: 3 },
    "vi",
    fakeT
  );
  assert.deepEqual(payload, {
    type: "success",
    title: "vi:raid-status.sync.followupSuccessTitle",
    description: 'vi:raid-status.sync.followupApplied {"n":3}',
  });
});

test("raid-status manual sync followup maps no-new and failed outcomes", () => {
  assert.deepEqual(
    buildManualSyncFollowupPayload({ outcome: "synced-no-new" }, "en", fakeT),
    {
      type: "info",
      title: "en:raid-status.sync.followupNeutralTitle",
      description: "en:raid-status.sync.followupSyncedNoNew",
    }
  );

  assert.deepEqual(
    buildManualSyncFollowupPayload({ outcome: "failed" }, "jp", fakeT),
    {
      type: "warn",
      title: "jp:raid-status.sync.followupFailedTitle",
      description: "jp:raid-status.sync.followupFailedDescription",
    }
  );
});

test("raid-status manual sync followup ignores unknown outcomes", () => {
  assert.equal(buildManualSyncFollowupPayload({ outcome: "timeout" }, "vi", fakeT), null);
  assert.equal(buildManualSyncFollowupPayload(null, "vi", fakeT), null);
});
