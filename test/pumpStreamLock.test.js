/**
 * One worker streams pump.fun at a time (src/services/pumpStream.js): a
 * Postgres advisory lock on a connection of its own, so Chainstack's two
 * connections are one stream and one spare. Another worker waits on standby
 * and takes over when the holder stops or its connection drops; a holder that
 * loses its connection stops streaming at once. The Yellowstone client is a
 * stand-in; the lock is the real test database's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { DATABASE_URL: DB || '' });
const env = require('../src/config/env');
const yellowstone = require('../src/providers/yellowstone');
const ps = require('../src/services/pumpStream');

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); }
};

test('one worker streams; another waits on standby and takes over; a lost connection stops the stream at once', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  const pool = db.getPool();
  t.after(async () => { ps.halt(); yellowstone._reset(); Object.assign(env, { yellowstoneGrpcUrl: '', yellowstoneGrpcToken: '' }); await pool.end(); });

  const streams = [];
  class Client {
    async connect() {}
    async subscribeWithReconnect() { const s = Object.assign(new EventEmitter(), { ended: false, write() {}, end() { this.ended = true; } }); streams.push(s); return s; }
  }
  yellowstone._setClient(() => ({ default: Client, CommitmentLevel: { CONFIRMED: 1 } }));
  Object.assign(env, { yellowstoneGrpcUrl: 'https://yellowstone.example:443', yellowstoneGrpcToken: 'test-token' });
  ps._setStandbyMs(100);

  // Another worker holds the lock: this one waits on standby, and opens nothing.
  const other = await pool.connect();
  const tryLock = async c => (await c.query('SELECT pg_try_advisory_lock($1) AS ok', [ps.LOCK_ID])).rows[0].ok;
  assert.equal(await tryLock(other), true);
  assert.equal(await ps.start(), false);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(streams.length, 0, 'on standby: no connection to the provider');

  // It stops: the standby takes over within a check or two.
  await other.query('SELECT pg_advisory_unlock($1)', [ps.LOCK_ID]);
  await until(() => ps._leading());
  assert.equal(streams.length, 1);
  assert.equal(await tryLock(other), false, 'while this worker streams, no other can');

  // Its lock connection drops: it stops streaming at once, and the lock is free for another worker.
  ps.lost(new Error('Connection terminated unexpectedly'));
  assert.equal(ps._leading(), false);
  assert.equal(streams[0].ended, true, 'the stream is closed before anyone else can open one');
  await until(() => tryLock(other));
  // Now the other worker holds it, so this one stays on standby.
  await new Promise(r => setTimeout(r, 300));
  assert.equal(ps._leading(), false);
  assert.equal(streams.length, 1);

  // Released again: this one takes over; halting gives the lock back.
  await other.query('SELECT pg_advisory_unlock($1)', [ps.LOCK_ID]);
  await until(() => ps._leading());
  assert.equal(streams.length, 2);
  ps.halt();
  assert.equal(streams[1].ended, true);
  await until(() => tryLock(other));
  await other.query('SELECT pg_advisory_unlock($1)', [ps.LOCK_ID]);
  other.release();
});

test('a stopped stream never restarts by itself', async t => {
  let opens = 0;
  let current;
  class Client {
    async connect() {}
    async subscribeWithReconnect() { opens++; current = Object.assign(new EventEmitter(), { write() {}, end() {} }); return current; }
  }
  yellowstone._setClient(() => ({ default: Client }));
  Object.assign(env, { yellowstoneGrpcUrl: 'https://yellowstone.example:443', yellowstoneGrpcToken: 'test-token' });
  t.after(() => { yellowstone._reset(); Object.assign(env, { yellowstoneGrpcUrl: '', yellowstoneGrpcToken: '' }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const stop = await yellowstone.subscribeTransactions('restart-test', { accountInclude: [ps.PUMP] }, () => {});
  current.emit('error', new Error('UNAVAILABLE: retries spent'));
  t.mock.timers.tick(61000);
  for (let i = 0; i < 50 && opens < 2; i++) await new Promise(r => setImmediate(r)); // setTimeout is mocked here
  assert.equal(opens, 2, 'the client gave up: it starts again a minute later');

  current.emit('error', new Error('UNAVAILABLE: retries spent'));
  stop();
  t.mock.timers.tick(61000);
  await new Promise(r => setImmediate(r));
  assert.equal(opens, 2, 'stopped while waiting to restart: it stays stopped');
});
