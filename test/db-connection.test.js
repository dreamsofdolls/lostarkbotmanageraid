const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/offline-test';
process.env.MONGO_ENSURE_INDEXES = 'false';

async function freshDb(t) {
  const before = new Map(['disconnected', 'error'].map(event => [event, new Set(mongoose.connection.listeners(event))]));
  t.after(() => {
    for (const [event, listeners] of before) {
      for (const listener of mongoose.connection.listeners(event)) {
        if (!listeners.has(listener)) mongoose.connection.removeListener(event, listener);
      }
    }
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  delete require.cache[require.resolve('../bot/db')];
  return require('../bot/db');
}

test('concurrent database callers share one connection attempt', async t => {
  const db = await freshDb(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  t.mock.method(mongoose, 'connect', async () => { calls++; await pending; return mongoose; });
  const requests = Array.from({ length: 20 }, () => db.connectDB());
  release();
  await Promise.all(requests);
  assert.equal(calls, 1);
});

test('reconnects retain one database listener per event', async t => {
  const db = await freshDb(t);
  const counts = Object.fromEntries(['disconnected', 'error'].map(event => [event, mongoose.connection.listenerCount(event)]));
  t.mock.method(mongoose, 'connect', async () => mongoose);
  for (let attempt = 0; attempt < 4; attempt++) {
    await db.connectDB();
    await db.disconnectDB();
  }
  for (const event of ['disconnected', 'error']) {
    assert.equal(mongoose.connection.listenerCount(event), counts[event] + 1);
  }
});

test('a failed database connection releases pending work for retry', async t => {
  const db = await freshDb(t);
  let calls = 0;
  t.mock.method(mongoose, 'connect', async () => {
    if (++calls === 1) throw new Error('offline');
    return mongoose;
  });
  const outcomes = await Promise.allSettled([db.connectDB(), db.connectDB()]);
  assert.ok(outcomes.every(result => result.status === 'rejected'));
  await db.connectDB();
  assert.equal(calls, 2);
});

test('shutdown waits for an in-flight connection and leaves it closed', async t => {
  const db = await freshDb(t);
  const originalState = mongoose.connection._readyState;
  t.after(() => { mongoose.connection._readyState = originalState; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let disconnects = 0;
  t.mock.method(mongoose, 'connect', async () => { await pending; mongoose.connection._readyState = 1; return mongoose; });
  t.mock.method(mongoose, 'disconnect', async () => { disconnects++; mongoose.connection._readyState = 0; });
  const connecting = db.connectDB();
  const closing = db.disconnectDB();
  release();
  await Promise.all([connecting, closing]);
  assert.equal(mongoose.connection.readyState, 0);
  assert.equal(disconnects, 1);
});

test('concurrent database callers share DNS fallback instead of retrying separately', async t => {
  const db = await freshDb(t);
  const dns = require('node:dns');
  const configured = [];
  let attempts = 0;
  t.mock.method(dns, 'setServers', servers => configured.push(servers));
  t.mock.method(mongoose, 'connect', async () => {
    if (++attempts === 1) throw Object.assign(new Error('DNS refused'), { code: 'ECONNREFUSED', syscall: 'querySrv' });
    return mongoose;
  });
  await Promise.all(Array.from({ length: 20 }, () => db.connectDB()));
  assert.equal(attempts, 2);
  assert.equal(configured.length, 1);
});

test('all callers wait for the same index setup to finish', async t => {
  const db = await freshDb(t);
  const previous = process.env.MONGO_ENSURE_INDEXES;
  process.env.MONGO_ENSURE_INDEXES = 'true';
  t.after(() => { process.env.MONGO_ENSURE_INDEXES = previous; });
  const models = [require('../bot/models/user'), require('../bot/models/guildConfig'), require('../bot/models/localSyncPreview')];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  for (const Model of models) t.mock.method(Model, 'createIndexes', async () => { calls++; started(); await pending; });
  t.mock.method(mongoose, 'connect', async () => mongoose);
  const first = db.connectDB();
  await entered;
  let settled = false;
  const second = db.connectDB().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 3);
});
