const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadFingerprintSnapshot() {
  const file = path.join(__dirname, "..", "web", "js", "profile", "data", "profile-snapshot.js");
  const source = fs.readFileSync(file, "utf8")
    .replace(/import[\s\S]*?from\s+"[^"]+";\s*/g, "")
    .replace(/\bexport function /g, "function ");
  const sandbox = {};
  vm.runInNewContext(`${source}\nglobalThis.__fingerprintSnapshot = fingerprintSnapshot;`, sandbox, {
    filename: file,
  });
  return sandbox.__fingerprintSnapshot;
}

function makeSnapshot({ contribution = 31.3, rContribution = 73.5 } = {}) {
  return {
    criteria: { range: { type: "full" } },
    accounts: [
      {
        accountName: "Qiylyn",
        characters: [
          {
            name: "Notmeow",
            role: "support",
            stats: {
              encounters: 45,
              lastFightStart: 1710000000000,
              avgSynergyGivenShare: contribution,
              avgRdpsDamageGivenShare: rContribution,
            },
            scores: {
              overall: 75.2,
              mvp: 74.3,
              raidContribution: 66.3,
            },
            build: { spec: "Blessed Aura" },
          },
        ],
      },
    ],
    encounters: [
      {
        encounterId: "enc-1",
        characterName: "Notmeow",
        fightStart: 1710000000000,
        metrics: {
          dps: 1000,
          synergyGivenShare: contribution,
          rdpsDamageGivenShare: rContribution,
        },
      },
    ],
  };
}

test("profile fingerprint changes when support contribution shares change", () => {
  const fingerprintSnapshot = loadFingerprintSnapshot();
  const base = fingerprintSnapshot(makeSnapshot());

  assert.notEqual(
    fingerprintSnapshot(makeSnapshot({ contribution: 0 })),
    base,
    "Contribution % must participate in the browser no-change fingerprint"
  );
  assert.notEqual(
    fingerprintSnapshot(makeSnapshot({ rContribution: 0 })),
    base,
    "rContribution % must participate in the browser no-change fingerprint"
  );
});
