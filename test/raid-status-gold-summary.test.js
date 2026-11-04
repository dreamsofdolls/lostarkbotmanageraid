"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGoldReceiveSummaryNotice,
  buildModeSummaryNotice,
} = require("../bot/handlers/raid-status/gold/gold-summary");

const fakeClassEmoji = (className) => (className ? `[${className}]` : "");

function modeEntry(name, className, itemLevel, outcomes) {
  return {
    name,
    className,
    missing: false,
    itemLevel,
    outcomes: outcomes.map(([raidKey, modeKey, outcome, minItemLevel = 0]) => ({
      raidKey, modeKey, outcome, minItemLevel,
    })),
  };
}

function modeNotice(results, collapsed = []) {
  return buildModeSummaryNotice({
    result: { ok: true, denied: false, results },
    collapsed,
    lang: "vi",
    getClassEmoji: fakeClassEmoji,
  });
}

// The spec example: Act 4, Kazeros and Belgardin to Hard for three characters.
const SPEC_EXAMPLE = [
  modeEntry("Soulrano", "Destroyer", 1771, [
    ["armoche", "hard", "immediate", 1720],
    ["kazeros", "hard", "immediate", 1730],
    ["belgardin", "hard", "immediate", 1770],
  ]),
  modeEntry("Nailaduk", "Bard", 1772, [
    ["armoche", "hard", "immediate", 1720],
    ["kazeros", "hard", "deferred", 1730],
    ["belgardin", "hard", "deferred", 1770],
  ]),
  modeEntry("Priscilladuk", "Paladin", 1765, [
    ["armoche", "hard", "immediate", 1720],
    ["kazeros", "hard", "immediate", 1730],
    ["belgardin", "hard", "ineligible", 1770],
  ]),
];

test("mode summary groups raids by outcome per character", () => {
  const notice = modeNotice(SPEC_EXAMPLE);
  assert.equal(notice.type, "success");
  assert.equal(notice.title, "Đổi độ khó xong cho 3 con");
  const lines = notice.description.split("\n");
  assert.equal(lines[0], "[Destroyer] **Soulrano**: Act 4, Kazeros, Belgardin → Hard · đổi ngay");
  assert.equal(
    lines[1],
    "[Bard] **Nailaduk**: Act 4 → Hard · đổi ngay; Kazeros, Belgardin → Hard · sau reset"
  );
  assert.equal(lines[2], "[Paladin] **Priscilladuk**: Act 4, Kazeros → Hard · đổi ngay");
  assert.match(lines[3], /Priscilladuk · Belgardin Hard cần 1770 \(đang 1765\)/);
  assert.equal(lines.length, 4);
});

test("mode summary title counts only characters with a change", () => {
  const notice = modeNotice([
    modeEntry("Soulrano", "Destroyer", 1771, [["armoche", "hard", "noop", 1720]]),
    modeEntry("Nailaduk", "Bard", 1772, [["armoche", "hard", "immediate", 1720]]),
  ]);
  assert.equal(notice.title, "Đổi độ khó xong cho 1 con");
  assert.doesNotMatch(notice.description, /Soulrano/);
  assert.equal(notice.description, "[Bard] **Nailaduk**: Act 4 → Hard · đổi ngay");
});

test("mode summary names a cancelled queued change", () => {
  const notice = modeNotice([
    modeEntry("Soulrano", "Destroyer", 1771, [["horizon", null, "cancelled", 0]]),
  ]);
  assert.equal(notice.description, "[Destroyer] **Soulrano**: Horizon: huỷ hẹn");
});

test("mode summary with only ineligible picks warns that nothing changed", () => {
  const notice = modeNotice([
    modeEntry("Soulrano", "Destroyer", 1771, [["belgardin", "nightmare", "ineligible", 1780]]),
    modeEntry("Nailaduk", "Bard", 1772, [["belgardin", "nightmare", "ineligible", 1780]]),
  ]);
  assert.equal(notice.type, "warn");
  assert.equal(notice.title, "Chưa đổi được gì");
  assert.match(notice.description, /Soulrano · Belgardin Nightmare cần 1780 \(đang 1771\)/);
  assert.match(notice.description, /Nailaduk · Belgardin Nightmare cần 1780 \(đang 1772\)/);
});

test("mode summary with only no-op picks sends no notice", () => {
  assert.equal(modeNotice([
    modeEntry("Soulrano", "Destroyer", 1771, [["armoche", "hard", "noop", 1720]]),
  ]), null);
});

test("mode summary names the mode kept when one raid got two picks", () => {
  const notice = modeNotice(
    [modeEntry("Soulrano", "Destroyer", 1771, [["belgardin", "hard", "immediate", 1770]])],
    [{ raidKey: "belgardin", keptModeKey: "hard", droppedModeKeys: ["normal"] }]
  );
  assert.match(notice.description, /Belgardin.*lấy Hard/);
});

test("mode summary names characters missing from the roster", () => {
  const notice = modeNotice([
    modeEntry("Soulrano", "Destroyer", 1771, [["armoche", "hard", "immediate", 1720]]),
    { name: "Ghostchar", className: "", missing: true, itemLevel: 0, outcomes: [] },
  ]);
  assert.match(notice.description, /Ghostchar/);
});

function goldEntry(name, className, status, { added = [], removed = [], kept = [], skipped = [] } = {}) {
  return { name, className, status, added, removed, kept, skipped };
}

function goldNotice(results, receive, ignoredTicks = false) {
  return buildGoldReceiveSummaryNotice({
    result: { ok: true, denied: false, results },
    receive,
    ignoredTicks,
    lang: "vi",
    getClassEmoji: fakeClassEmoji,
  });
}

test("gold summary lists the ticked set and each character's raids in and out", () => {
  const moved = { added: ["serca"], removed: ["belgardin"], kept: ["armoche", "kazeros", "serca"] };
  const notice = goldNotice([
    goldEntry("Soulrano", "Destroyer", "changed", moved),
    goldEntry("Nailaduk", "Bard", "changed", moved),
    goldEntry("Priscilladuk", "Paladin", "changed", moved),
  ], { kind: "set", raidKeys: ["serca", "armoche", "kazeros"] });
  assert.equal(notice.type, "success");
  assert.equal(notice.title, "Gold nhận đổi xong cho 3 con");
  assert.deepEqual(notice.description.split("\n"), [
    "Nhận gold: **Act 4 · Kazeros · Serca**",
    "[Destroyer] **Soulrano**: Serca vào, Belgardin ra",
    "[Bard] **Nailaduk**: Serca vào, Belgardin ra",
    "[Paladin] **Priscilladuk**: Serca vào, Belgardin ra",
  ]);
});

test("gold summary marks pinned characters and skipped raids", () => {
  const notice = goldNotice([
    goldEntry("Soulrano", "Destroyer", "pinned", { kept: ["armoche", "kazeros", "belgardin"] }),
    goldEntry("Lowbie", "Paladin", "changed", {
      added: ["serca"], removed: ["armoche"], kept: ["kazeros", "serca"], skipped: ["belgardin"],
    }),
    goldEntry("Nailaduk", "Bard", "unchanged", { kept: ["armoche", "kazeros", "belgardin"] }),
  ], { kind: "set", raidKeys: ["kazeros", "serca", "belgardin"] });
  assert.equal(notice.title, "Gold nhận đổi xong cho 2 con");
  const lines = notice.description.split("\n");
  assert.match(lines[1], /^\[Destroyer\] \*\*Soulrano\*\*: .*Act 4 · Kazeros · Belgardin.*chọn tay/);
  assert.match(lines[2], /^\[Paladin\] \*\*Lowbie\*\*: Serca vào, Act 4 ra · .*Belgardin/);
  assert.doesNotMatch(notice.description, /Nailaduk/);
});

test("gold auto summary lists each character's new raids and the ignored ticks", () => {
  const notice = goldNotice([
    goldEntry("Soulrano", "Destroyer", "changed", {
      added: ["belgardin"], removed: ["serca"], kept: ["belgardin", "kazeros", "armoche"],
    }),
    goldEntry("Nailaduk", "Bard", "pinned", { kept: ["belgardin", "kazeros", "armoche"] }),
  ], { kind: "auto" }, true);
  assert.equal(notice.type, "info");
  assert.equal(notice.title, "Artist tự chọn gold lại cho 2 con");
  const lines = notice.description.split("\n");
  assert.equal(lines[0], "[Destroyer] **Soulrano**: Belgardin · Kazeros · Act 4");
  assert.equal(lines[1], "[Bard] **Nailaduk**: Belgardin · Kazeros · Act 4");
  assert.match(lines[2], /bỏ qua/);
});

test("gold summary sends no notice when no character changed", () => {
  assert.equal(goldNotice([
    goldEntry("Soulrano", "Destroyer", "unchanged", { kept: ["armoche"] }),
  ], { kind: "set", raidKeys: ["armoche"] }), null);
});

test("summary stays within 4096 characters", () => {
  const raids = ["armoche", "kazeros", "serca", "horizon", "belgardin"];
  const sixteen = (index) => `Charactername${String(index).padStart(3, "0")}`;
  const longEmoji = (className) => `<:${className}:123456789012345678>`;
  const realistic = Array.from({ length: 6 }, (_, index) => modeEntry(
    sixteen(index), "destroyer", 1700,
    raids.map((raidKey, raidIndex) => [
      raidKey, "nightmare", raidIndex % 2 ? "deferred" : "ineligible", 1780,
    ])
  ));
  const flood = Array.from({ length: 300 }, (_, index) => modeEntry(
    sixteen(index), "destroyer", 1700,
    raids.map((raidKey) => [raidKey, "nightmare", "ineligible", 1780])
  ));
  for (const results of [realistic, flood]) {
    const notice = buildModeSummaryNotice({
      result: { ok: true, denied: false, results },
      collapsed: [],
      lang: "vi",
      getClassEmoji: longEmoji,
    });
    assert.ok(notice.description.length <= 4096, `length ${notice.description.length}`);
  }
  const floodNotice = buildModeSummaryNotice({
    result: { ok: true, denied: false, results: flood },
    collapsed: [],
    lang: "vi",
    getClassEmoji: longEmoji,
  });
  assert.ok(floodNotice.description.endsWith("..."));
});
