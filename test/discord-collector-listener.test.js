const test = require("node:test");
const assert = require("node:assert/strict");

const {
  guardCollectorListener,
} = require("../bot/utils/discord/collector-listener");

test("discord guardCollectorListener passes the emitted arguments through", async () => {
  const seen = [];
  const listener = guardCollectorListener("[test]", async (...args) => { seen.push(args); });

  await listener("component", "reason");

  assert.deepEqual(seen, [["component", "reason"]]);
});

test("discord guardCollectorListener logs a rejection with the customId instead of rethrowing", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => { errors.push(args); });
  const failure = Object.assign(new Error("Unknown interaction"), { code: 10062 });
  const listener = guardCollectorListener("[test] component", async () => { throw failure; });

  await listener({ customId: "page:next" });
  await listener();

  assert.deepEqual(errors, [
    ["[test] component page:next failed:", failure],
    ["[test] component failed:", failure],
  ]);
});
