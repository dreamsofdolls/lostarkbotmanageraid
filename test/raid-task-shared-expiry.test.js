"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clearUserLanguageCache } = require("../bot/services/i18n");
const { createSharedAddHandler } = require("../bot/handlers/raid/task/shared/shared-add");
const {
  getVisibleSharedTasks,
  parseSharedTaskExpiresAt,
} = require("../bot/utils/raid/tasks/shared-tasks");

// Far-future date so the handler's "expiry already passed" guard never trips.
const TYPED_DATE = "2036-10-05";
const LEADS = [
  { lang: "vi", timeZone: "Asia/Ho_Chi_Minh", offsetHours: 7 },
  { lang: "jp", timeZone: "Asia/Tokyo", offsetHours: 9 },
  { lang: "en", timeZone: "UTC", offsetHours: 0 },
];

function formatDayIn(ms, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "long" }).format(ms);
}

async function runSharedAdd(lang) {
  clearUserLanguageCache();
  const docs = [];
  const notices = [];
  const handler = createSharedAddHandler({
    User: {
      findOne(query, projection) {
        if (projection) return { lean: async () => ({ language: lang }) };
        const doc = {
          accounts: [{ accountName: "main", characters: [], sharedTasks: [] }],
          async save() {},
        };
        docs.push(doc);
        return Promise.resolve(doc);
      },
    },
    saveWithRetry: async (fn) => fn(),
    dailyResetStartMs: () => 111,
    weekResetStartMs: () => 222,
    resolveTaskWriteTarget: async (executorId) => ({ discordId: executorId, viaShare: false, canEdit: true }),
    replyViewOnlyShareNotice: async () => {},
    replyTaskNotice: async (_interaction, notice) => { notices.push(notice); },
  });
  await handler({
    user: { id: `lead-${lang}` },
    options: {
      getString: (name) => ({ roster: "main", preset: "event_shop", expires_at: TYPED_DATE })[name] ?? null,
      getBoolean: () => false,
    },
  });
  return { task: docs.at(-1)?.accounts[0].sharedTasks[0], notice: notices.at(-1) };
}

test("parseSharedTaskExpiresAt ends the typed day in the language timezone", () => {
  for (const { lang, offsetHours } of LEADS) {
    assert.equal(
      parseSharedTaskExpiresAt(TYPED_DATE, lang),
      Date.UTC(2036, 9, 5, 23 - offsetHours, 59, 59, 999),
      lang,
    );
  }
  assert.ok(Number.isNaN(parseSharedTaskExpiresAt("2036-02-30", "jp")));
  assert.equal(parseSharedTaskExpiresAt("", "jp"), null);
});

for (const { lang, timeZone, offsetHours } of LEADS) {
  test(`shared-add expires_at shows and expires on the typed day for a ${lang} lead`, async () => {
    const { task, notice } = await runSharedAdd(lang);
    assert.equal(notice?.type, "success");
    assert.ok(task, "expected the shared task to be stored");

    const endOfTypedDay = Date.UTC(2036, 9, 5, 23 - offsetHours, 59, 59, 999);
    assert.equal(task.expiresAt, endOfTypedDay);

    // Discord renders <t:..:D> in the viewer's timezone; the lead must see the day they typed.
    const shownSeconds = Number(notice.description.match(/<t:(\d+):D>/)?.[1]);
    assert.equal(shownSeconds, Math.floor(task.expiresAt / 1000));
    assert.equal(formatDayIn(shownSeconds * 1000, timeZone), "5 October 2036");

    // Live through the last millisecond of the typed day, gone at local midnight.
    const account = { sharedTasks: [task] };
    assert.equal(getVisibleSharedTasks(account, endOfTypedDay).length, 1);
    assert.equal(getVisibleSharedTasks(account, endOfTypedDay + 1).length, 0);
  });
}
