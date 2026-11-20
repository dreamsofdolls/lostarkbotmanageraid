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

test("the Solo Reader names Bible auto-sync, not Local Sync, when its link is disabled", async () => {
  const { TRANSLATIONS } = await import("../web/js/core/locales.js");
  for (const lang of ["vi", "jp", "en"]) {
    assert.match(TRANSLATIONS[lang].solo.identity.disabled || "", /Bible/, lang);
  }
});

test("party deltas past the preview job limit keep the newest clears", async () => {
  const { capPartyDeltas } = await import("../web/js/sync/encounter-query.js");
  const { normalizePreviewDeltas } = require("../bot/services/local-sync/core/preview-jobs");
  const partyDeltas = Array.from({ length: 700 }, (_, index) => ({
    boss: "Boss",
    difficulty: "Normal",
    cleared: 1,
    charName: `Member${index}`,
    sourceCharName: "Source",
    lastClearMs: index + 1,
  }));

  const capped = capPartyDeltas(partyDeltas);

  assert.doesNotThrow(() => normalizePreviewDeltas(capped));
  assert.equal(Math.min(...capped.map((delta) => delta.lastClearMs)), 700 - capped.length + 1);
  const few = partyDeltas.slice(0, 3);
  assert.deepEqual(capPartyDeltas(few), few);
});

test("buildDiff drops stale other-mode clears once DB already completed the raid, and Solo excludes partial other-mode progress", async () => {
  const { buildLocalSyncCatalog } = require("../bot/services/local-sync/core/catalog");
  const {
    buildActionableBucketKeySet,
    buildDiff,
    bucketize,
    setCatalog,
  } = await import("../web/js/sync/preview-utils.js");
  setCatalog(buildLocalSyncCatalog());

  // Case 1: DB already has Act 4 Normal 2/2, file still has older Hard G1.
  const completedRoster = [{
    accountName: "Roster",
    characters: [{
      name: "Aki",
      class: "Artist",
      itemLevel: 1750,
      assignedRaids: {
        armoche: {
          modeKey: "normal",
          G1: { difficulty: "Normal", completedDate: 1500 },
          G2: { difficulty: "Normal", completedDate: 2000 },
        },
      },
    }],
  }];
  const mixedBuckets = bucketize([
    ["Armoche, Sentinel of the Abyss", "Normal", 1, "Aki", 1, 2000],
    ["Brelshaza, Ember in the Ashes", "Hard", 1, "Aki", 1, 1000],
  ]);
  assert.equal(mixedBuckets.length, 2);
  const completedDiff = buildDiff(completedRoster, mixedBuckets, { currentWeekStartMs: 500 });
  assert.equal(
    buildActionableBucketKeySet(completedDiff).size,
    0,
    "completed raid must not keep an older other-mode gate actionable"
  );

  // Case 2: DB has Hard G1, file has Solo G2 (cumulative G1+G2).
  const partialHardG1Roster = [{
    accountName: "Roster",
    characters: [{
      name: "Aki",
      class: "Artist",
      itemLevel: 1750,
      assignedRaids: {
        armoche: {
          modeKey: "hard",
          G1: { difficulty: "Hard", completedDate: 1500 },
          G2: { difficulty: "Hard", completedDate: null },
        },
      },
    }],
  }];
  const soloG2Buckets = bucketize([
    ["Armoche, Sentinel of the Abyss", "Solo", 1, "Aki", 1, 2000],
  ]);
  const soloDiff = buildDiff(partialHardG1Roster, soloG2Buckets, {
    allowedModeKeys: ["solo"],
    currentWeekStartMs: 500,
  });
  assert.equal(
    buildActionableBucketKeySet(soloDiff, { includeModeConflict: false }).size,
    0,
    "Solo reader must exclude a Solo clear when another difficulty has partial current-week progress"
  );

  // Case 3: DB has Hard G2 only, file has Solo G1 only.
  const partialHardG2Roster = [{
    accountName: "Roster",
    characters: [{
      name: "Aki",
      class: "Artist",
      itemLevel: 1750,
      assignedRaids: {
        armoche: {
          modeKey: "hard",
          G1: { difficulty: "Hard", completedDate: null },
          G2: { difficulty: "Hard", completedDate: 1500 },
        },
      },
    }],
  }];
  const soloG1Buckets = bucketize([
    ["Brelshaza, Ember in the Ashes", "Solo", 1, "Aki", 1, 2000],
  ]);
  const soloG1Diff = buildDiff(partialHardG2Roster, soloG1Buckets, {
    allowedModeKeys: ["solo"],
    currentWeekStartMs: 500,
  });
  assert.equal(
    buildActionableBucketKeySet(soloG1Diff, { includeModeConflict: false }).size,
    0,
    "Solo reader must exclude Solo G1 when another gate of the same raid has current-week progress in another mode"
  );
});
