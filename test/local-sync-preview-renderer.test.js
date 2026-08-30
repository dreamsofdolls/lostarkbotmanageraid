const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

async function loadPreviewRenderer() {
  const file = path.join(
    __dirname,
    "..",
    "web",
    "js",
    "sync",
    "render",
    "preview-renderer.js"
  );
  const source = fs.readFileSync(file, "utf8").replace(/^import .*;\r?\n/gm, "");
  const stubs = `
const t = (key, values = {}) => key === "preview.schemaDebug"
  ? String(values?.table || "")
  : key;
const getRaidLabel = (key) => key;
const getRaidSpecificModeLabel = (_raidKey, modeKey) => modeKey;
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const formatGold = (value) => String(value);
const formatRelativeTime = (value) => String(value);
const renderCharPendingLabel = (_icon, character) => character.charName || "";
const renderCharPendingRow = (label, tail) => \`<li>\${label}\${tail}</li>\`;
const resolvePreviewLastSync = () => null;
`;
  const url = `data:text/javascript;base64,${Buffer.from(stubs + source).toString("base64")}`;
  return import(url);
}

function makeAccount(accountName, characterName) {
  const cell = {
    raidKey: "serca",
    modeKey: "hard",
    sourceModeKey: "hard",
    gates: ["G1"],
    states: { G1: "pending" },
  };
  return {
    accountName,
    characters: [{
      name: characterName,
      class: "Artist",
      itemLevel: 1750,
      cells: [cell],
    }],
    raidCards: [{
      raidKey: "serca",
      modeKey: "hard",
      chars: [{
        name: characterName,
        class: "Artist",
        itemLevel: 1750,
        gates: ["G1"],
        states: { G1: "pending" },
      }],
    }],
  };
}

test("preview renderer keeps pagination, view toggle, and escaping behavior after decomposition", async () => {
  const dom = new JSDOM('<div id="preview"></div>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;

  try {
    const { renderDiffPage } = await loadPreviewRenderer();
    window.__artistDiff = [
      makeAccount("Roster <one>", "Aki"),
      makeAccount("Roster two", "Bardella"),
    ];
    window.__artistMeta = {
      distinctChars: 2,
      clears: 1,
      schemaDebug: { table: '<img src=x onerror="boom">' },
    };
    window.__artistUnmappedBosses = ['Boss <script>'];
    window.__artistRosterPage = 0;
    window.__artistViewMode = "char";
    window.__artistCollectDiffStateCounts = () => ({ pending: 1 });
    const output = document.getElementById("preview");

    renderDiffPage(output);
    assert.match(output.innerHTML, /char-cards-grid/);
    assert.match(output.textContent, /Roster <one>/);
    assert.doesNotMatch(output.innerHTML, /<img src=x onerror/);
    assert.doesNotMatch(output.innerHTML, /<script>/);

    document.getElementById("view-toggle").click();
    assert.equal(window.__artistViewMode, "raid");
    assert.match(output.innerHTML, /raid-card-header/);

    document.getElementById("roster-next").click();
    assert.equal(window.__artistRosterPage, 1);
    assert.match(output.textContent, /Roster two/);
    assert.equal(document.getElementById("roster-next").disabled, true);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  }
});
