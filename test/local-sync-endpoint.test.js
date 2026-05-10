process.env.RAID_MANAGER_ID = "test-manager";
process.env.LOCAL_SYNC_TOKEN_SECRET = "test-secret-at-least-16-chars-long";

const { PassThrough } = require("node:stream");
const test = require("node:test");
const assert = require("node:assert/strict");

const { mintToken } = require("../bot/services/local-sync");
const { createRaidSyncEndpoint } = require("../bot/services/local-sync/sync-endpoint");

function makeReq({ token, method = "POST", body = { deltas: [] } } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  process.nextTick(() => req.end(JSON.stringify(body)));
  return req;
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
  return {
    findOne() {
      return {
        select() {
          return {
            lean: async () => doc,
          };
        },
      };
    },
    async findOneAndUpdate() {
      throw new Error("stale local-sync POST should not stamp success");
    },
  };
}

test("raid-sync endpoint rejects a rotated-out local-sync token before applying", async () => {
  const staleToken = mintToken("u1");
  const currentToken = mintToken("u1");
  let applyCalls = 0;
  const User = makeUserStub({
    discordId: "u1",
    localSyncEnabled: true,
    lastLocalSyncToken: currentToken,
    lastLocalSyncTokenExpAt: 9999999999,
    accounts: [],
  });
  const handler = createRaidSyncEndpoint({
    User,
    applyRaidSetForDiscordId: async () => {
      applyCalls += 1;
      return { matched: true, updated: true };
    },
  });
  const res = makeRes();

  await handler(makeReq({ token: staleToken }), res, { query: {} });

  assert.equal(res.status, 401);
  assert.equal(applyCalls, 0);
  assert.deepEqual(res.json(), {
    ok: false,
    error: "token revoked - open a new local-sync link",
  });
});

test("raid-sync endpoint returns 409 when reset disables local-sync during apply", async () => {
  const token = mintToken("u1");
  const calls = [];
  const User = makeUserStub({
    discordId: "u1",
    localSyncEnabled: true,
    lastLocalSyncToken: token,
    lastLocalSyncTokenExpAt: 9999999999,
    accounts: [
      {
        accountName: "Roster",
        characters: [
          { name: "Aki", class: "Artist", itemLevel: 1750, assignedRaids: {} },
        ],
      },
    ],
  });
  const handler = createRaidSyncEndpoint({
    User,
    applyRaidSetForDiscordId: async (args) => {
      calls.push(args);
      return { syncDisabled: true };
    },
  });
  const res = makeRes();

  await handler(
    makeReq({
      token,
      body: {
        deltas: [
          {
            boss: "Brelshaza, Ember in the Ashes",
            difficulty: "Normal",
            cleared: true,
            charName: "Aki",
            lastClearMs: Date.now(),
          },
        ],
      },
    }),
    res,
    { query: {} }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].requireLocalSyncEnabled, true);
  assert.equal(res.status, 409);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().rejected[0].reason, "local_sync_disabled");
});

test("raid-sync endpoint only shrinks the token that performed the apply", async () => {
  const token = mintToken("u1");
  const updateCalls = [];
  const User = {
    findOne() {
      return {
        select() {
          return {
            lean: async () => ({
              discordId: "u1",
              localSyncEnabled: true,
              lastLocalSyncToken: token,
              lastLocalSyncTokenExpAt: 9999999999,
              accounts: [
                {
                  accountName: "Roster",
                  characters: [
                    { name: "Aki", class: "Artist", itemLevel: 1750, assignedRaids: {} },
                  ],
                },
              ],
            }),
          };
        },
      };
    },
    async findOneAndUpdate() {
      return { discordId: "u1", localSyncEnabled: true };
    },
    async updateOne(filter, update) {
      updateCalls.push({ filter, update });
      return { modifiedCount: 1 };
    },
  };
  const handler = createRaidSyncEndpoint({
    User,
    applyRaidSetForDiscordId: async () => ({ matched: true, updated: true, displayName: "Aki" }),
  });
  const res = makeRes();

  await handler(
    makeReq({
      token,
      body: {
        deltas: [
          {
            boss: "Brelshaza, Ember in the Ashes",
            difficulty: "Normal",
            cleared: true,
            charName: "Aki",
            lastClearMs: Date.now(),
          },
        ],
      },
    }),
    res,
    { query: {} }
  );

  assert.equal(res.status, 200);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].filter, { discordId: "u1", lastLocalSyncToken: token });
  assert.equal(typeof updateCalls[0].update.$set.lastLocalSyncTokenExpAt, "number");
  assert.equal(res.json().newExpSec, updateCalls[0].update.$set.lastLocalSyncTokenExpAt);
});
