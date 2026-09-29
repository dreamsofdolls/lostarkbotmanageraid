const test = require("node:test");
const assert = require("node:assert/strict");

test("Solo encounter query requires difficulty and filters before grouping and limit", async () => {
  const { buildEncounterPreviewSql } = await import("../web/js/sync/encounter-query.js");

  assert.throws(
    () => buildEncounterPreviewSql({
      tableSql: '"encounter_preview"',
      bossSql: '"boss"',
      tsSql: '"timestamp"',
      scope: "solo",
    }),
    /requires an encounter difficulty column/
  );

  const sql = buildEncounterPreviewSql({
    tableSql: '"encounter_preview"',
    bossSql: '"boss"',
    tsSql: '"timestamp"',
    diffSql: '"difficulty"',
    scope: "solo",
  });
  const filterAt = sql.indexOf("LOWER(TRIM(COALESCE");
  assert.ok(filterAt > sql.indexOf("WHERE"));
  assert.ok(filterAt < sql.indexOf("GROUP BY"));
  assert.ok(filterAt < sql.indexOf("LIMIT 512"));
  assert.match(sql, /IN \('solo', 'solo mode'\)/);
  assert.doesNotMatch(sql, /AS difficulty,\s*'Normal'/);
});

test("legacy and full encounter query preserve the Normal fallback", async () => {
  const { buildEncounterPreviewSql } = await import("../web/js/sync/encounter-query.js");
  for (const scope of [undefined, "full"]) {
    const sql = buildEncounterPreviewSql({
      tableSql: '"encounter"',
      bossSql: '"boss"',
      tsSql: '"timestamp"',
      scope,
    });
    assert.match(sql, /'Normal' AS difficulty/);
    assert.doesNotMatch(sql, /solo mode/);
  }
});

test("encounter query takes party members from the same latest row as last_ms", async () => {
  const { buildEncounterPreviewSql } = await import("../web/js/sync/encounter-query.js");
  const sql = buildEncounterPreviewSql({
    tableSql: '"encounter_preview"',
    bossSql: '"boss"',
    tsSql: '"timestamp"',
    diffSql: '"difficulty"',
    clearedSql: '"cleared"',
    charSql: '"local_player"',
    playersSql: '"players"',
  });

  assert.match(sql, /MAX\("timestamp"\) AS last_ms/);
  assert.match(sql, /COALESCE\("players", ''\) AS players/);
  assert.doesNotMatch(sql, /MAX\("players"\)/);
});

test("encounter query keeps as many groups as a preview job accepts deltas", async () => {
  const { buildEncounterPreviewSql } = await import("../web/js/sync/encounter-query.js");
  const { normalizePreviewDeltas } = require("../bot/services/local-sync/core/preview-jobs");
  const sql = buildEncounterPreviewSql({
    tableSql: '"encounter_preview"',
    bossSql: '"boss"',
    tsSql: '"timestamp"',
  });
  const limit = Number(/LIMIT (\d+);/.exec(sql)?.[1]);

  // Each group becomes at most one delta, so a smaller limit drops the
  // oldest groups of large rosters while the server would take them.
  assert.doesNotThrow(() => normalizePreviewDeltas(Array(limit).fill(null)));
  assert.throws(
    () => normalizePreviewDeltas(Array(limit + 1).fill(null)),
    /too many deltas/
  );
});

test("Solo row defense accepts only explicit Solo labels", async () => {
  const { filterRowsForSyncScope } = await import("../web/js/sync/encounter-query.js");
  const rows = [
    ["Boss A", "Solo", 1, "Aki"],
    ["Boss B", "solo mode", 1, "Aki"],
    ["Boss C", "Normal", 1, "Aki"],
    ["Boss D", "", 1, "Aki"],
  ];

  assert.deepEqual(filterRowsForSyncScope(rows, "solo"), rows.slice(0, 2));
  assert.equal(filterRowsForSyncScope(rows, "full"), rows);
});

test("Solo actionable keys exclude cross-mode conflicts while full sync keeps them", async () => {
  const { buildActionableBucketKeySet } = await import("../web/js/sync/preview-utils.js");
  const diff = [{
    characters: [{
      name: "Aki",
      cells: [{
        raidKey: "armoche",
        modeKey: "solo",
        gates: ["G1"],
        states: { G1: "mode-conflict" },
      }],
    }],
  }];

  assert.equal(buildActionableBucketKeySet(diff).size, 1);
  assert.equal(buildActionableBucketKeySet(diff, { includeModeConflict: false }).size, 0);
});

test("all web locales provide Solo companion copy and a Solo mode label", async () => {
  const { TRANSLATIONS } = await import("../web/js/core/locales.js");
  for (const lang of ["vi", "jp", "en"]) {
    assert.equal(TRANSLATIONS[lang].modeLabels.solo.length > 0, true, lang);
    assert.match(TRANSLATIONS[lang].solo.header.h1, /Solo/i, lang);
    assert.match(TRANSLATIONS[lang].solo.well.nothingHint, /Solo/i, lang);
    assert.match(TRANSLATIONS[lang].solo.done.title, /Solo/i, lang);
    assert.doesNotMatch(JSON.stringify(TRANSLATIONS[lang]), /\/raid-sync\b/, lang);
  }
});

test("all web locales cover every page state and message the Local Reader renders", async () => {
  const { TRANSLATIONS } = await import("../web/js/core/locales.js");
  const required = {
    identity: ["noToken", "malformed", "expired", "revoked", "disabled", "linkValid", "linkValidSec", "linkedAnonymous"],
    well: ["drop", "dropHint", "dragging", "restore", "restoreHint", "reading", "readingHint", "unit", "nothing", "nothingHint"],
    problem: ["openFailed", "notLoaLogs", "schema", "soloDifficulty"],
    file: ["path", "change", "updated", "invalidExt", "fsaUnavailable", "pickFailed", "restoreDenied", "liveStatic", "liveRetrying", "liveWalWarning"],
    sync: ["btn", "syncing", "retry", "fileBusy", "walUnsafe", "rosterRetrying", "partial", "retryable", "failed", "busy", "stale", "networkError", "conflict", "conflictMore"],
    done: ["stamp", "title", "rejected", "hint"],
  };
  for (const lang of ["vi", "jp", "en"]) {
    for (const [section, keys] of Object.entries(required)) {
      for (const key of keys) {
        assert.equal(TRANSLATIONS[lang][section][key].length > 0, true, `${lang}.${section}.${key}`);
      }
    }
    // Every blocked and problem title shown in the well has a hint beside it.
    for (const kind of ["noToken", "malformed", "expired", "revoked", "disabled"]) {
      assert.equal(TRANSLATIONS[lang].identity[`${kind}Hint`].length > 0, true, `${lang}.${kind}Hint`);
    }
    for (const kind of required.problem) {
      assert.equal(TRANSLATIONS[lang].problem[`${kind}Hint`].length > 0, true, `${lang}.${kind}Hint`);
    }
    assert.match(TRANSLATIONS[lang].file.updated, /\{time\}/, lang);
    assert.match(TRANSLATIONS[lang].done.title, /<em>.*\{n\}.*<\/em>/, lang);
  }
});

test("web i18n overlays Solo copy without changing full companion copy", async () => {
  global.window = { __artistLang: "en", __artistSyncScope: "solo" };
  try {
    const { t } = await import("../web/js/core/i18n.js");
    assert.equal(t("header.h1"), "Solo Local Reader");
    assert.match(t("well.nothingHint"), /Solo clears only/);

    global.window.__artistSyncScope = "full";
    assert.equal(t("header.h1"), "Local Reader");
    assert.doesNotMatch(t("well.nothingHint"), /Solo/);
  } finally {
    delete global.window;
  }
});
