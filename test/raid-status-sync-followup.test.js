const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildManualSyncFollowupPayload,
} = require("../bot/handlers/raid-status/sync/sync-followup");
const { TRANSLATIONS } = require("../bot/locales");

function fakeT(key, lang, vars = {}) {
  const suffix = vars && Object.keys(vars).length
    ? ` ${JSON.stringify(vars)}`
    : "";
  return `${lang}:${key}${suffix}`;
}

test("raid-status manual sync followup maps applied outcome to a done card", () => {
  const payload = buildManualSyncFollowupPayload(
    { outcome: "applied", newGatesApplied: 3 },
    "vi",
    fakeT
  );
  assert.deepEqual(payload, {
    kind: "done",
    title: "vi:raid-status.sync.followupSuccessTitle",
    description: 'vi:raid-status.sync.followupApplied {"n":3}',
  });
});

test("raid-status manual sync followup maps no-new and failed outcomes", () => {
  assert.deepEqual(
    buildManualSyncFollowupPayload({ outcome: "synced-no-new" }, "en", fakeT),
    {
      kind: "empty",
      title: "en:raid-status.sync.followupNeutralTitle",
      description: "en:raid-status.sync.followupSyncedNoNew",
    }
  );

  assert.deepEqual(
    buildManualSyncFollowupPayload({ outcome: "failed" }, "jp", fakeT),
    {
      kind: "busy",
      title: "jp:raid-status.sync.followupFailedTitle",
      description: "jp:raid-status.sync.followupFailedDescription",
      tip: "jp:raid-status.sync.followupFailedTip",
    }
  );
});

test("raid-status manual sync followup has a fixed title and a pooled hero sentence", () => {
  for (const lang of ["vi", "en", "jp"]) {
    const sync = TRANSLATIONS[lang]["raid-status"].sync;
    assert.equal(typeof sync.followupSuccessTitle, "string", lang);
    assert.equal(typeof sync.followupNeutralTitle, "string", lang);
    assert.ok(Array.isArray(sync.followupApplied.variants), lang);

    const payload = buildManualSyncFollowupPayload({ outcome: "applied", newGatesApplied: 3 }, lang);
    assert.equal(payload.title, sync.followupSuccessTitle, lang);
    assert.equal(typeof payload.description, "string", lang);
    assert.match(payload.description, /3/, lang);
  }
});

test("raid-status manual sync followup ignores unknown outcomes", () => {
  assert.equal(buildManualSyncFollowupPayload({ outcome: "timeout" }, "vi", fakeT), null);
  assert.equal(buildManualSyncFollowupPayload(null, "vi", fakeT), null);
});
