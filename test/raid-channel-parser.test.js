const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeRaidChannelContent,
  parseRaidMessage,
} = require("../bot/services/raid/channel-monitor/channel-monitor-parser");

test("raid-channel parser normalizes separators and act 4 spacing", () => {
  assert.equal(normalizeRaidChannelContent("Act   4 + HM, Qiylyn G2"), "act4 HM Qiylyn G2");
  assert.equal(normalizeRaidChannelContent("Horizon   Cathedral + HM, Qiylyn G2"), "horizon HM Qiylyn G2");
  assert.deepEqual(parseRaidMessage("Act   4 + HM, Qiylyn G2"), {
    raidKey: "armoche",
    modeKey: "hard",
    charNames: ["qiylyn"],
    gate: "G2",
  });
});

test("raid-channel parser dedupes multi-character targets", () => {
  assert.deepEqual(parseRaidMessage("kaz hm Qiylyn Qiylyn Morrah"), {
    raidKey: "kazeros",
    modeKey: "hard",
    charNames: ["qiylyn", "morrah"],
    gate: null,
  });
});

test("raid-channel parser accepts reset and rs without a difficulty", () => {
  const expected = {
    raidKey: "armoche",
    modeKey: null,
    action: "reset",
    charNames: ["qiylyn", "morrah"],
    gate: null,
  };

  assert.deepEqual(parseRaidMessage("act4 reset Qiylyn Morrah Qiylyn"), expected);
  assert.deepEqual(parseRaidMessage("act4 rs Qiylyn Morrah"), expected);
});

test("raid-channel parser rejects difficulty or gate tokens on reset", () => {
  assert.deepEqual(parseRaidMessage("act4 hm reset Qiylyn"), {
    error: "reset-with-difficulty",
  });
  assert.deepEqual(parseRaidMessage("act4 rs Qiylyn G1"), {
    error: "reset-with-gate",
  });
});

test("raid-channel parser preserves existing alias semantics", () => {
  assert.equal(parseRaidMessage("Serca nm Qiylyn").modeKey, "normal");
  assert.equal(parseRaidMessage("Serca 9m Qiylyn").modeKey, "nightmare");
  assert.equal(parseRaidMessage("Cathedral Level 1 Qiylyn").modeKey, "normal");
  assert.equal(parseRaidMessage("Cathedral l2 Qiylyn").modeKey, "hard");
  assert.equal(parseRaidMessage("Cathedral l3 Qiylyn").modeKey, "nightmare");
  assert.deepEqual(parseRaidMessage("Horizon Cathedral 9m Qiylyn G2"), {
    raidKey: "horizon",
    modeKey: "nightmare",
    charNames: ["qiylyn"],
    gate: "G2",
  });
  assert.deepEqual(parseRaidMessage("セルカ ハード Soulrano"), {
    raidKey: "serca",
    modeKey: "hard",
    charNames: ["soulrano"],
    gate: null,
  });
});

test("raid-channel parser accepts Solo in English and Japanese", () => {
  assert.deepEqual(parseRaidMessage("Act4 Solo Qiylyn"), {
    raidKey: "armoche",
    modeKey: "solo",
    charNames: ["qiylyn"],
    gate: null,
  });
  assert.deepEqual(parseRaidMessage("アクト4 ソロ Qiylyn G2"), {
    raidKey: "armoche",
    modeKey: "solo",
    charNames: ["qiylyn"],
    gate: "G2",
  });
});

test("raid-channel parser accepts any number of raids before the difficulty", () => {
  assert.deepEqual(parseRaidMessage("kaz serca hard Qiylyn"), {
    raidKeys: ["kazeros", "serca"],
    modeKey: "hard",
    charNames: ["qiylyn"],
    gate: null,
  });
  assert.deepEqual(parseRaidMessage("act4, kazeros hm abc1,abc2"), {
    raidKeys: ["armoche", "kazeros"],
    modeKey: "hard",
    charNames: ["abc1", "abc2"],
    gate: null,
  });
  assert.deepEqual(parseRaidMessage("act4 final hm abc1 abc2"), {
    raidKeys: ["armoche", "kazeros"],
    raidDisplayNames: { kazeros: "Final" },
    modeKey: "hard",
    charNames: ["abc1", "abc2"],
    gate: null,
  });
  assert.deepEqual(parseRaidMessage("final hm abc1"), {
    raidKey: "kazeros",
    raidDisplayNames: { kazeros: "Final" },
    modeKey: "hard",
    charNames: ["abc1"],
    gate: null,
  });
});

test("raid-channel parser returns explicit ambiguity and ordering errors", () => {
  assert.deepEqual(parseRaidMessage("kaz hard normal Qiylyn"), {
    error: "multi-difficulty",
    difficulties: ["hard", "normal"],
  });
  assert.deepEqual(parseRaidMessage("kaz hard Qiylyn G1 G2"), {
    error: "multi-gate",
    gates: ["G1", "G2"],
  });
  assert.deepEqual(parseRaidMessage("act4 kazro hard Qiylyn"), {
    error: "invalid-raid",
    raids: ["kazro"],
  });
  assert.deepEqual(parseRaidMessage("kazro hard Qiylyn"), {
    error: "invalid-raid",
    raids: ["kazro"],
  });
  assert.deepEqual(parseRaidMessage("act4 hard kazeros Qiylyn"), {
    error: "raid-after-mode",
    raids: ["kazeros"],
  });
});

test("raid-channel parser supports multi-raid reset", () => {
  assert.deepEqual(parseRaidMessage("act4, kazeros rs Qiylyn Morrah"), {
    raidKeys: ["armoche", "kazeros"],
    modeKey: null,
    action: "reset",
    charNames: ["qiylyn", "morrah"],
    gate: null,
  });
});
