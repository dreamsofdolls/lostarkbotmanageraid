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
  assert.ok(filterAt < sql.indexOf("LIMIT 200"));
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

test("Solo preview uses its own timestamp source and label", async () => {
  const { resolvePreviewLastSync } = await import("../web/js/sync/preview-stats.js");
  const summary = {
    scope: "solo",
    lastSync: { localSyncAt: 100, autoManageSyncAt: 200 },
  };

  assert.deepEqual(resolvePreviewLastSync(summary), {
    ms: 100,
    labelKey: "preview.statsLastSyncSoloMode",
  });
  assert.equal(resolvePreviewLastSync({ scope: "solo", lastSync: { autoManageSyncAt: 200 } }), null);
  assert.deepEqual(resolvePreviewLastSync({ lastSync: summary.lastSync }), {
    ms: 200,
    labelKey: "preview.statsLastSyncBibleMode",
  });
});

test("all web locales provide Solo companion copy and a Solo mode label", async () => {
  const { TRANSLATIONS } = await import("../web/js/core/locales.js");
  for (const lang of ["vi", "jp", "en"]) {
    assert.equal(TRANSLATIONS[lang].modeLabels.solo.length > 0, true, lang);
    assert.match(TRANSLATIONS[lang].solo.header.h1, /Solo/i, lang);
    assert.match(TRANSLATIONS[lang].solo.file.hint, /Solo/i, lang);
    assert.equal(TRANSLATIONS[lang].solo.preview.statsLastSyncSoloMode.length > 0, true, lang);
    assert.equal(TRANSLATIONS[lang].solo.diff.state["mode-conflict"].length > 0, true, lang);
  }
});

test("web i18n overlays Solo copy without changing full companion copy", async () => {
  global.window = { __artistLang: "en", __artistSyncScope: "solo" };
  try {
    const { t } = await import("../web/js/core/i18n.js");
    assert.equal(t("header.h1"), "Solo Web Companion");
    assert.match(t("sync.hint"), /only encounters whose difficulty is Solo/);

    global.window.__artistSyncScope = "full";
    assert.equal(t("header.h1"), "Local Sync");
    assert.match(t("sync.hint"), /cleared encounters above/);
  } finally {
    delete global.window;
  }
});
