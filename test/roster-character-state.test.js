const test = require("node:test");
const assert = require("node:assert/strict");

const {
  preserveRosterCharacterState,
} = require("../bot/handlers/roster/character-state");

test("preserveRosterCharacterState carries bible and public-log fields only when present", () => {
  const record = { name: "Qiylyn" };
  const existing = {
    bibleSerial: "serial",
    bibleCid: "cid",
    bibleRid: "rid",
    publicLogDisabled: true,
    publicLogDisabledAt: undefined,
  };

  const result = preserveRosterCharacterState(record, existing);

  assert.equal(result, record);
  assert.equal(result.bibleSerial, "serial");
  assert.equal(result.bibleCid, "cid");
  assert.equal(result.bibleRid, "rid");
  assert.equal(result.publicLogDisabled, true);
  assert.equal(Object.hasOwn(result, "publicLogDisabledAt"), false);
});

test("preserveRosterCharacterState supports mongoose-like documents", () => {
  const record = { name: "Qiylyn" };
  const existing = {
    toObject: () => ({ bibleSerial: "serial-from-doc" }),
  };

  preserveRosterCharacterState(record, existing);

  assert.equal(record.bibleSerial, "serial-from-doc");
});
