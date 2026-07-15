const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLocalSyncCatalog,
  normalizeDifficulty,
} = require("../bot/services/local-sync/core/catalog");
const { createCatalogEndpoint } = require("../bot/services/local-sync/http/endpoints/catalog-endpoint");

function makeRes() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body || "";
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

test("local-sync catalog exposes raid metadata used by the web preview", () => {
  const catalog = buildLocalSyncCatalog();
  assert.equal(catalog.raids.serca.label, "Serca");
  assert.equal(catalog.raids.serca.modes.nightmare.minItemLevel, 1740);
  assert.deepEqual(catalog.raids.serca.gates, ["G1", "G2"]);
  assert.equal(catalog.raids.horizon.label, "Horizon");
  assert.equal(catalog.raids.horizon.modes.normal.label, "Level 1");
  assert.equal(catalog.raids.horizon.modes.hard.label, "Level 2");
  assert.equal(catalog.raids.horizon.modes.nightmare.label, "Level 3");
  assert.equal(catalog.raids.horizon.modes.normal.minItemLevel, 1700);
  assert.equal(catalog.raids.horizon.modes.hard.minItemLevel, 1720);
  assert.equal(catalog.raids.horizon.modes.nightmare.minItemLevel, 1750);
  assert.equal(catalog.raids.horizon.modes.solo, undefined);
  assert.equal(catalog.raids.armoche.modes.solo.label, "Solo");
  assert.equal(catalog.raids.armoche.modes.solo.manualOnly, true);
  assert.deepEqual(
    catalog.bossToRaidGate.find(([boss]) => boss === "Witch of Agony, Serca"),
    ["Witch of Agony, Serca", { raidKey: "serca", gate: "G1" }]
  );
  assert.deepEqual(
    catalog.bossToRaidGate.find(([boss]) => boss === "Archbishop Arcenos"),
    ["Archbishop Arcenos", { raidKey: "horizon", gate: "G1" }]
  );
});

test("local-sync catalog shares difficulty and class mappings", () => {
  const catalog = buildLocalSyncCatalog();
  assert.equal(normalizeDifficulty("Inferno"), "nightmare");
  assert.equal(normalizeDifficulty("Trial"), "nightmare");
  assert.equal(normalizeDifficulty("Level 1"), "normal");
  assert.equal(normalizeDifficulty("level2"), "hard");
  assert.equal(normalizeDifficulty("L3"), "nightmare");
  assert.equal(normalizeDifficulty("Solo"), "solo");
  assert.equal(normalizeDifficulty("Solo Mode"), "solo");
  assert.equal(catalog.classesById["204"].label, "Bard");
  assert.equal(catalog.classesById["204"].icon, "bard");
});

test("local-sync catalog endpoint returns public metadata", async () => {
  const handler = createCatalogEndpoint();
  const res = makeRes();

  await handler({ method: "GET" }, res);

  const body = res.json();
  assert.equal(res.status, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(body.ok, true);
  assert.equal(body.catalog.raids.kazeros.label, "Kazeros");
  assert.equal(body.catalog.raids.horizon.modes.nightmare.minItemLevel, 1750);
  assert.equal(body.catalog.classesById["204"].icon, "bard");
});
