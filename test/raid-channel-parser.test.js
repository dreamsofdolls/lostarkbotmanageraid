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

test("raid-channel parser returns explicit ambiguity errors", () => {
  assert.deepEqual(parseRaidMessage("kaz serca hard Qiylyn"), {
    error: "multi-raid",
    raids: ["kazeros", "serca"],
  });
  assert.deepEqual(parseRaidMessage("kaz hard normal Qiylyn"), {
    error: "multi-difficulty",
    difficulties: ["hard", "normal"],
  });
  assert.deepEqual(parseRaidMessage("kaz hard Qiylyn G1 G2"), {
    error: "multi-gate",
    gates: ["G1", "G2"],
  });
});
