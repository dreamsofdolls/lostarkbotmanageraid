process.env.RAID_MANAGER_ID = "test-manager";
process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const test = require("node:test");
const assert = require("node:assert/strict");

const { mintToken } = require("../bot/services/local-sync");
const { createRosterEndpoint } = require("../bot/services/local-sync/roster-endpoint");

function makeReq({ token, method = "GET" } = {}) {
  return {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

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

function makeUserStub(doc) {
  const calls = { findOne: [], select: [] };
  return {
    calls,
    findOne(filter) {
      calls.findOne.push(filter);
      return {
        select(fields) {
          calls.select.push(fields);
          return {
            lean: async () => doc,
          };
        },
      };
    },
  };
}

test("roster endpoint rejects a still-valid token when local-sync is disabled", async () => {
  const token = mintToken("u1");
  const User = makeUserStub({
    discordId: "u1",
    localSyncEnabled: false,
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki" }] }],
  });
  const handler = createRosterEndpoint({ User });
  const res = makeRes();

  await handler(makeReq({ token }), res, { query: {} });

  assert.equal(res.status, 409);
  assert.deepEqual(res.json(), {
    ok: false,
    error: "local-sync disabled - run /raid-auto-manage action:local-on to re-enable",
  });
  assert.deepEqual(User.calls.findOne[0], { discordId: "u1" });
  assert.match(User.calls.select[0], /localSyncEnabled/);
});

test("roster endpoint returns only the slim roster fields when local-sync is enabled", async () => {
  const token = mintToken("u1");
  const User = makeUserStub({
    discordId: "u1",
    localSyncEnabled: true,
    lastLocalSyncToken: token,
    lastLocalSyncTokenExpAt: 9999999999,
    accounts: [
      {
        accountName: "Roster",
        ignored: "nope",
        characters: [
          {
            name: "Aki",
            class: "Bard",
            itemLevel: 1740,
            assignedRaids: { serca: { G1: { completedDate: 1, difficulty: "Hard" } } },
            sideTasks: [{ name: "should not leak" }],
          },
        ],
      },
    ],
  });
  const handler = createRosterEndpoint({ User });
  const res = makeRes();

  await handler(makeReq({ token }), res, { query: {} });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), {
    ok: true,
    discordId: "u1",
    accounts: [
      {
        accountName: "Roster",
        characters: [
          {
            name: "Aki",
            class: "Bard",
            itemLevel: 1740,
            assignedRaids: { serca: { G1: { completedDate: 1, difficulty: "Hard" } } },
          },
        ],
      },
    ],
  });
});

test("roster endpoint rejects a rotated-out local-sync token", async () => {
  const staleToken = mintToken("u1");
  const currentToken = mintToken("u1");
  const User = makeUserStub({
    discordId: "u1",
    localSyncEnabled: true,
    lastLocalSyncToken: currentToken,
    lastLocalSyncTokenExpAt: 9999999999,
    accounts: [{ accountName: "Roster", characters: [{ name: "Aki" }] }],
  });
  const handler = createRosterEndpoint({ User });
  const res = makeRes();

  await handler(makeReq({ token: staleToken }), res, { query: {} });

  assert.equal(res.status, 401);
  assert.deepEqual(res.json(), {
    ok: false,
    error: "token revoked - open a new local-sync link",
  });
});
