"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRaidChannelDmFallbackText,
  buildRaidChannelErrorHint,
  summarizeRaidChannelResults,
} = require("../bot/services/raid/channel-monitor/channel-monitor-results");

const UI = { icons: { done: "[done]", reset: "[reset]", warn: "[warn]" } };
const raidMeta = {
  label: "Act 4 Normal",
  minItemLevel: 1700,
};

function createRecorder() {
  const calls = [];
  return {
    calls,
    t(key, lang, vars = {}) {
      calls.push({ key, lang, vars });
      return key;
    },
  };
}

test("raid-channel result summary groups progress and error outcomes", () => {
  const summary = summarizeRaidChannelResults([
    { charName: "Done", matched: true, updated: true },
    { charName: "Already", matched: true, alreadyComplete: true },
    { charName: "AlreadyReset", matched: true, alreadyReset: true },
    { charName: "Missing", matched: false },
    { charName: "Low", matched: true, ineligibleItemLevel: 1600 },
    { charName: "Errored", error: "save failed" },
  ]);

  assert.equal(summary.hasProgress, true);
  assert.equal(summary.hasErrors, true);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.alreadyCount, 2);
  assert.deepEqual(summary.notFoundResults.map((r) => r.charName), ["Missing"]);
  assert.deepEqual(summary.ineligibleResults.map((r) => r.charName), ["Low"]);
  assert.deepEqual(summary.errorResults.map((r) => r.charName), ["Errored"]);
});

test("raid-channel DM fallback renders reset and already-reset outcomes", () => {
  const recorder = createRecorder();
  const content = buildRaidChannelDmFallbackText({
    results: [
      { charName: "Qiylyn", matched: true, updated: true },
      { charName: "Bardly", matched: true, alreadyReset: true },
    ],
    raidMeta: { ...raidMeta, label: "Act 4" },
    effectiveGates: [],
    statusType: "reset",
    authorLang: "vi",
    UI,
    userId: "user-1",
    t: recorder.t.bind(recorder),
  });

  assert.equal(content, "text-parser.dmFallback");
  assert.deepEqual(
    recorder.calls.map((call) => call.key),
    [
      "text-parser.dmFallbackReset",
      "text-parser.dmFallbackAlreadyReset",
      "text-parser.dmFallback",
    ]
  );
  assert.equal(recorder.calls[2].vars.icon, "[reset]");
});

test("raid-channel error hint renders only present sections plus partial note", () => {
  const recorder = createRecorder();
  const summary = summarizeRaidChannelResults([
    { charName: "Done", matched: true, updated: true },
    { charName: "Missing", matched: false },
    { charName: "Low", matched: true, displayName: "Lowbie", ineligibleItemLevel: 1600 },
  ]);

  const content = buildRaidChannelErrorHint({
    summary,
    raidMeta,
    authorLang: "en",
    UI,
    t: recorder.t.bind(recorder),
  });

  assert.equal(
    content,
    [
      "text-parser.errorNotFound",
      "text-parser.errorIneligible",
      "text-parser.errorPartialNote",
    ].join("\n")
  );
  assert.equal(recorder.calls[0].vars.names, "`Missing`");
  assert.match(recorder.calls[1].vars.names, /\*\*Lowbie\*\* \(iLvl 1600\)/);
});

test("raid-channel DM fallback text combines updated and already-complete names", () => {
  const recorder = createRecorder();
  const content = buildRaidChannelDmFallbackText({
    results: [
      { charName: "Qiylyn", matched: true, updated: true },
      { charName: "Bardly", matched: true, alreadyComplete: true },
    ],
    raidMeta,
    effectiveGates: ["G1", "G2"],
    authorLang: "vi",
    UI,
    userId: "user-1",
    t: recorder.t.bind(recorder),
  });

  assert.equal(content, "text-parser.dmFallback");
  assert.deepEqual(
    recorder.calls.map((call) => call.key),
    [
      "text-parser.dmFallbackMarkDone",
      "text-parser.dmFallbackAlready",
      "text-parser.dmFallback",
    ]
  );
  assert.equal(recorder.calls[0].vars.scope, "Act 4 Normal \u00b7 G1, G2");
  assert.equal(recorder.calls[2].vars.userId, "user-1");
});
