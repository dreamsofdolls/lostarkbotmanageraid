const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLocalSyncCatalog,
  normalizeDifficulty,
} = require("../bot/services/local-sync/catalog");
const { createCatalogEndpoint } = require("../bot/services/local-sync/catalog-endpoint");

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
  assert.deepEqual(
    catalog.bossToRaidGate.find(([boss]) => boss === "Witch of Agony, Serca"),
    ["Witch of Agony, Serca", { raidKey: "serca", gate: "G1" }]
  );
});

test("local-sync catalog shares difficulty and class mappings", () => {
  const catalog = buildLocalSyncCatalog();
  assert.equal(normalizeDifficulty("Inferno"), "nightmare");
  assert.equal(normalizeDifficulty("Trial"), "nightmare");
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
  assert.equal(body.catalog.classesById["204"].icon, "bard");
});
