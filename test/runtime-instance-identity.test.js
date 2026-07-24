"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRuntimeInstanceIdentity,
} = require("../bot/services/runtime/instance-identity");

test("runtime instance identity exposes Railway consumer coordinates without secrets", () => {
  const identity = buildRuntimeInstanceIdentity({
    env: {
      RAILWAY_SERVICE_NAME: "raid manage",
      RAILWAY_ENVIRONMENT_NAME: "prod\nfake",
      RAILWAY_DEPLOYMENT_ID: "deploy/1",
      RAILWAY_REPLICA_ID: "replica=1",
      DISCORD_TOKEN: "must-not-appear",
    },
    pid: 42,
  });

  assert.equal(
    identity,
    "service=raid_manage environment=prod_fake deployment=deploy_1 replica=replica_1 pid=42"
  );
  assert.doesNotMatch(identity, /must-not-appear/);
});

test("runtime instance identity falls back to hostname outside Railway", () => {
  const identity = buildRuntimeInstanceIdentity({
    env: { HOSTNAME: "local-host" },
    pid: 7,
  });

  assert.equal(
    identity,
    "service=local environment=local deployment=local replica=local-host pid=7"
  );
});
