const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const observations = [], commands = [];
  const state = { permit: true, trace: { requestId: 'request-A' }, telemetryThrows: false };
  class Redis {
    on() { return this; }
    sendCommand(command) { commands.push(command); return command.promise; }
  }
  class RedisCircuitOpenError extends Error {}
  const instance = loadTypeScript(path.resolve('src/config/redis.ts'), {
    ioredis: Redis, dotenv: { config() {} }, './ENV': {}, '../lib/logger': { warn() {}, info() {} },
    '../lib/monitoring/performanceMetrics': { recordRedisCommandMetric(value) { if (state.telemetryThrows) throw Error('metrics offline'); } },
    '../lib/monitoring/requestTrace': { getRequestTrace: () => state.trace, recordTraceRedisCommand(ms, outcome, trace) { observations.push({ ms, ...outcome, trace }); } },
    '../lib/cache/redisCircuitBreaker': { RedisCircuitOpenError, acquireRedisCircuitPermit: () => state.permit, getRedisCircuitSnapshot: () => ({ retryAfterMs: 200 }), forceCloseRedisCircuit() {}, forceOpenRedisCircuit() {}, recordRedisCircuitFailure() {}, recordRedisCircuitSuccess() {} },
  }).default;
  const command = name => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { name, promise, resolve, reject }; };
  return { instance, observations, commands, state, command, RedisCircuitOpenError };
}
test('Redis keeps pipeline command promise identity; failures create no second rejection', async () => {
  const f = fixture(); const command = f.command('eval');
  const result = f.instance.sendCommand(command); assert.equal(result, command.promise);
  const expected = Error('redis timeout'); const rejection = assert.rejects(command.promise, error => error === expected);
  command.reject(expected); await rejection; await tick();
  assert.equal(f.observations.length, 1); assert.equal(f.observations[0].error, true);
});
test('Redis captures the originating request for commands, multi-get hits and misses', async () => {
  const f = fixture(); const trace = f.state.trace; const command = f.command('mget');
  f.instance.sendCommand(command); f.state.trace = { requestId: 'other-request' };
  command.resolve(['a', null, 'b']); await command.promise; await tick();
  assert.equal(f.observations[0].trace, trace); assert.equal(f.observations[0].hits, 2); assert.equal(f.observations[0].misses, 1);
});
test('circuit denial rejects the command used by pipelines, with no dispatch, and is counted', async () => {
  const f = fixture(); f.state.permit = false; const command = f.command('get');
  const rejection = assert.rejects(command.promise, f.RedisCircuitOpenError);
  assert.equal(f.instance.sendCommand(command), command.promise); await rejection; await tick();
  assert.equal(f.commands.length, 0); assert.equal(f.observations.length, 1); assert.equal(f.observations[0].error, true);
});
test('a Redis write remains successful when telemetry fails', async () => {
  const f = fixture(); f.state.telemetryThrows = true; const command = f.command('set');
  const result = f.instance.sendCommand(command); command.resolve('OK');
  assert.equal(await result, 'OK'); await tick(); assert.equal(f.observations[0].hits, 0);
});
