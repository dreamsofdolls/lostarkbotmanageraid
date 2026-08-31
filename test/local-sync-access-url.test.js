"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COMPANION_SCOPE,
  buildLocalSyncUrl,
  issueLocalSyncAccessUrl,
} = require("../bot/services/local-sync");

test("buildLocalSyncUrl normalizes the base URL and safely encodes the token", () => {
  assert.equal(
    buildLocalSyncUrl("signed token.value", "https://raid.example.test///"),
    "https://raid.example.test/sync#token=signed%20token.value"
  );
  assert.equal(buildLocalSyncUrl("token", ""), null);
  assert.equal(buildLocalSyncUrl("", "https://raid.example.test"), null);
});

test("issueLocalSyncAccessUrl skips token work when the companion is not configured", async () => {
  let called = false;
  const url = await issueLocalSyncAccessUrl({
    discordId: "viewer",
    lang: "vi",
    UserModel: {},
    baseUrl: "",
    tokenProvider: async () => {
      called = true;
      return "unexpected";
    },
  });

  assert.equal(url, null);
  assert.equal(called, false);
});

test("issueLocalSyncAccessUrl forwards identity, scope, and an existing user snapshot", async () => {
  const UserModel = {};
  const userDoc = { lastLocalSyncToken: "stored" };
  let issuedArgs = null;
  const discordUser = {
    globalName: "Traine",
    displayAvatarURL: () => "https://cdn.example.test/avatar.webp",
  };

  const url = await issueLocalSyncAccessUrl({
    discordId: "viewer",
    lang: "en",
    UserModel,
    discordUser,
    userDoc,
    scope: COMPANION_SCOPE.solo,
    baseUrl: "https://raid.example.test/",
    tokenProvider: async (...args) => {
      issuedArgs = args;
      return "solo token";
    },
  });

  assert.equal(url, "https://raid.example.test/sync#token=solo%20token");
  assert.deepEqual(issuedArgs, [
    "viewer",
    "en",
    {
      UserModel,
      identity: {
        username: "Traine",
        avatarUrl: "https://cdn.example.test/avatar.webp",
      },
      scope: COMPANION_SCOPE.solo,
      userDoc,
    },
  ]);
});
