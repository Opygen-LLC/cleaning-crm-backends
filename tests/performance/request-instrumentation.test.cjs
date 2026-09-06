const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const cache = new Map();
const load = name => loadTypeScript(path.resolve(__dirname, '../../src/lib/monitoring', name + '.ts'), {}, cache);
const trace = load('requestTrace');
const memo = load('requestMemo');
const pg = load('pgInstrumentation');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const inRequest = fn => trace.runWithRequestTrace({ requestId: 'request', traceId: 'trace' }, fn);

test('one request deduplicates concurrent access; another request and background work never share it', async () => {
  let reads = 0; const read = async () => ++reads;
  await inRequest(async () => { assert.deepEqual(await Promise.all([memo.requestMemo('tenant', read, () => true), memo.requestMemo('tenant', read, () => true)]), [1, 1]); });
  assert.equal(await inRequest(() => memo.requestMemo('tenant', read, () => true)), 2);
  assert.equal(await memo.requestMemo('tenant', read, () => true), 3);
  assert.equal(await memo.requestMemo('tenant', read, () => true), 4);
});
test('in-flight pre-invalidation result cannot restore the old request slot or overwrite a newer load', async () => {
  await inRequest(async () => {
    const old = deferred(); let reads = 0;
    const read = () => ++reads === 1 ? old.promise : Promise.resolve('current');
    const first = memo.requestMemo('tenant', read, () => true);
    memo.forgetRequestMemo('tenant');
    const second = memo.requestMemo('tenant', read, () => true);
    old.resolve('draft');
    assert.deepEqual(await Promise.all([first, second]), ['current', 'current']);
    assert.equal(reads, 2);
  });
});
test('expired memo and rejected loads are evicted; closed requests do not supply credentials', async () => {
  await inRequest(async () => {
    let reads = 0, valid = true;
    const read = async () => ++reads;
    assert.equal(await memo.requestMemo('tenant', read, () => valid), 1);
    valid = false; assert.equal(await memo.requestMemo('tenant', read, () => valid), 3);
    await assert.rejects(memo.requestMemo('failure', async () => { throw Error('bad'); }, () => true));
    assert.equal(await memo.requestMemo('failure', async () => 'ok', () => true), 'ok');
    trace.getRequestTrace().closed = true;
    await memo.requestMemo('closed', read, () => true); await memo.requestMemo('closed', read, () => true);
    assert.equal(reads, 5);
  });
});
test('pool/query Promise and callback overloads preserve results, release, and account exactly once', async () => {
  const observations = []; let released = 0;
  const client = { release() { released++; }, query(...args) {
    const cb = args.at(-1); const result = { rows: [{ value: 1 }] };
    if (typeof cb === 'function') { queueMicrotask(() => cb(null, result)); return; }
    return Promise.resolve(result);
  } };
  const pool = { connect(callback) { if (callback) { queueMicrotask(() => callback(null, client, () => client.release())); return; } return Promise.resolve(client); } };
  pg.instrumentPgPool(pool, value => observations.push(value));
  pg.instrumentPgPool(pool, () => assert.fail('installed twice'));
  await inRequest(async () => {
    const c = await pool.connect(); assert.equal(c, client);
    assert.equal((await c.query('SELECT * FROM "business_website" WHERE id=$1', ['private'])).rows[0].value, 1);
    await new Promise((resolve, reject) => pool.connect((err, c, release) => {
      if (err) return reject(err);
      c.query('SELECT 1', (error, result) => { release(); if (error) reject(error); else { assert.equal(result.rows.length, 1); resolve(); } });
    }));
    const state = trace.getRequestTrace();
    assert.equal(state.dbPoolAcquisitions, 2); assert.equal(state.dbQueryCount, 2);
    assert.equal(state.dbPoolErrors, 0); assert.equal(released, 1);
  });
  assert.equal(observations.length, 2);
  assert.ok(observations.every(value => !Object.hasOwn(value, 'params')));
});
test('query completion keeps originating ALS scope even when another request is active', async () => {
  let done, first;
  const client = { query() { return new Promise(resolve => { done = resolve; }); } };
  const pool = { connect: () => Promise.resolve(client) };
  pg.instrumentPgPool(pool, () => {});
  const pending = inRequest(async () => { first = trace.getRequestTrace(); const c = await pool.connect(); return c.query('SELECT 1'); });
  await new Promise(resolve => setImmediate(resolve));
  await trace.runWithRequestTrace({ requestId: 'other', traceId: 'other' }, async () => { done({ rows: [] }); await pending; assert.equal(trace.getRequestTrace().dbQueryCount, 0); });
  assert.equal(first.dbQueryCount, 1);
});
test('driver failures remain failures even if telemetry throws', async () => {
  const failure = Error('driver'); const client = { query() { return Promise.reject(failure); } };
  const pool = { connect: () => Promise.resolve(client) };
  pg.instrumentPgPool(pool, () => { throw Error('telemetry'); });
  await inRequest(async () => { const c = await pool.connect(); await assert.rejects(c.query('UPDATE "website" SET x=$1'), e => e === failure); assert.equal(trace.getRequestTrace().dbQueryCount, 1); });
});
