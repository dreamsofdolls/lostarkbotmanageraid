const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getUserLanguage, setUserLanguage, clearUserLanguageCache,
  getGuildLanguage, setGuildLanguage,
} = require('../bot/services/i18n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const scopes = [
  { name: 'user', get: (id, Model) => getUserLanguage(id, { UserModel: Model }), set: (id, lang, Model) => setUserLanguage(id, lang, { UserModel: Model }), clear: clearUserLanguageCache },
  { name: 'guild', get: (id, Model) => getGuildLanguage(id, { GuildConfigModel: Model }), set: (id, lang, Model) => setGuildLanguage(id, lang, { GuildConfigModel: Model }), clear: () => {} },
];

for (const scope of scopes) {
  test(`${scope.name} locale coalesces a cold burst and keeps IDs and models separate`, async () => {
    scope.clear();
    const gate = deferred();
    let reads = 0;
    const Model = { findOne: () => { reads++; return { lean: () => gate.promise }; } };
    const pending = Array.from({ length: 20 }, () => scope.get('burst', Model));
    await tick();
    const coldReads = reads;
    gate.resolve({ language: 'jp' });
    assert.deepEqual(await Promise.all(pending), Array(20).fill('jp'));
    assert.equal(coldReads, 1);
    assert.equal(await scope.get('burst', Model), 'jp');
    assert.equal(reads, 1);

    scope.clear();
    const other = { findOne: () => ({ lean: async () => ({ language: 'vi' }) }) };
    assert.deepEqual(await Promise.all([scope.get('same-id', Model), scope.get('same-id', other)]), ['jp', 'vi']);
    await scope.get('different-id', Model);
    assert.equal(reads, 3);
  });

  test(`${scope.name} locale shares read failures without caching the fallback`, async () => {
    scope.clear();
    const gate = deferred();
    let reads = 0;
    const Model = { findOne: () => { reads++; return { lean: () => reads === 1 ? gate.promise : Promise.resolve({ language: 'jp' }) }; } };
    const pending = Array.from({ length: 10 }, () => scope.get('retry', Model));
    await tick();
    const coldReads = reads;
    gate.reject(new Error('temporary database failure'));
    const result = await Promise.all(pending);
    assert.deepEqual(result, Array(10).fill('vi'));
    assert.equal(coldReads, 1);
    assert.equal(await scope.get('retry', Model), 'jp');
    assert.equal(reads, 2);
  });

  test(`${scope.name} locale does not let a pending read undo a saved language`, async () => {
    scope.clear();
    const gate = deferred();
    const Model = { findOne: () => ({ lean: () => gate.promise }), updateOne: async () => ({}) };
    const pending = scope.get('changed', Model);
    await tick();
    await scope.set('changed', 'vi', Model);
    gate.resolve({ language: 'jp' });
    assert.equal(await pending, 'vi');
    assert.equal(await scope.get('changed', Model), 'vi');
  });

  test(`${scope.name} locale keeps the latest successful write when an older read fails`, async () => {
    scope.clear();
    const gate = deferred();
    const Model = { findOne: () => ({ lean: () => gate.promise }), updateOne: async () => ({}) };
    const pending = scope.get('changed-twice', Model);
    await tick();
    await scope.set('changed-twice', 'vi', Model);
    await scope.set('changed-twice', 'en', Model);
    gate.reject(new Error('old read timed out'));
    assert.equal(await pending, 'en');
    assert.equal(await scope.get('changed-twice', Model), 'en');
  });

  test(`${scope.name} locale leaves a pending read intact when saving fails`, async () => {
    scope.clear();
    const gate = deferred();
    const Model = { findOne: () => ({ lean: () => gate.promise }), updateOne: async () => { throw new Error('write failed'); } };
    const pending = scope.get('write-failed', Model);
    await tick();
    await assert.rejects(scope.set('write-failed', 'vi', Model), /write failed/);
    gate.resolve({ language: 'jp' });
    assert.equal(await pending, 'jp');
    assert.equal(await scope.get('write-failed', Model), 'jp');
  });

  if (scope.name === 'user') test(`${scope.name} locale clear detaches old requests without clearing their replacements`, async () => {
    scope.clear();
    const old = deferred(), fresh = deferred();
    let reads = 0;
    const Model = { findOne: () => { reads++; return { lean: () => reads === 1 ? old.promise : fresh.promise }; } };
    const pendingOld = scope.get('cleared', Model);
    await tick();
    scope.clear();
    const pendingFresh = scope.get('cleared', Model);
    await tick();
    old.resolve({ language: 'jp' });
    assert.equal(await pendingOld, 'jp');
    const follower = scope.get('cleared', Model);
    await tick();
    fresh.resolve({ language: 'vi' });
    assert.deepEqual(await Promise.all([pendingFresh, follower]), ['vi', 'vi']);
    assert.equal(reads, 2);
    assert.equal(await scope.get('cleared', Model), 'vi');
  });
}

test('a supplied viewer snapshot supersedes an older user-locale read', async () => {
  clearUserLanguageCache();
  const gate = deferred();
  const Model = { findOne: () => ({ lean: () => gate.promise }) };
  const pending = getUserLanguage('seeded', { UserModel: Model });
  await tick();
  assert.equal(await getUserLanguage('seeded', { UserModel: Model, userDoc: { language: 'en' } }), 'en');
  gate.resolve({ language: 'jp' });
  assert.equal(await pending, 'en');
  assert.equal(await getUserLanguage('seeded'), 'en');
});
