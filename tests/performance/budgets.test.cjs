const test = require('node:test');
const assert = require('node:assert/strict');
let tools;
test.before(async () => { tools = await import('../../scripts/performance/websiteBudgets.mjs'); });
const rows = (elapsed = 80, remote = 800) => Array.from({ length: 100 }, (_, index) => ({ path: '/website/status', method: 'GET', scenario: 'warm', status: 200, requestId: `r-${index}`, remoteClientMs: remote, apiHeadersMs: 2 }));
const logs = (requests, ms = 40) => new Map(requests.map(r => [r.requestId, { event: 'http_request', requestId: r.requestId, route: '/api/v1/website/status', method: 'GET', statusCode: 200, measurementClock: 'api-middleware-to-finish', totalDurationMs: ms, dbDurationMs: 10, dbQueryCount: 2, dbPoolAcquisitionMs: 3, redisDurationMs: 4, redisCommandCount: 5, externalDurationMs: 0, responseBytes: 500, responseCacheHits: 1, responseCacheMisses: 0 } ]));
test('remote roundtrip and header clocks never stand in for API finish latency', () => {
  const requests = rows(); const result = tools.evaluateMeasurements(requests, logs(requests));
  assert.equal(result.passed, true); assert.equal(result.endpoints[0].serverMs.p95, 40); assert.equal(result.endpoints[0].remoteClientMs.p95, 800);
  assert.equal(tools.evaluateMeasurements(requests, new Map()).passed, false);
  assert.equal(tools.evaluateMeasurements(requests, logs(requests, 101)).passed, false);
});
test('incomplete samples, failures, unverified cold and unobserved Redis outage cannot pass', () => {
  let requests = rows().slice(0, 2); assert.equal(tools.evaluateMeasurements(requests, logs(requests)).passed, false);
  requests = rows().map(r => ({ ...r, scenario: 'cold' })); assert.equal(tools.evaluateMeasurements(requests, logs(requests)).passed, false);
  requests = rows().map(r => ({ ...r, scenario: 'redis-outage' })); assert.equal(tools.evaluateMeasurements(requests, logs(requests), { outageP95: 500 }).passed, false);
  requests = rows().map(r => ({ ...r, status: 403 })); assert.equal(tools.evaluateMeasurements(requests, logs(requests)).passed, false);
});
test('actual route normalization and per-process log extraction are explicit', () => {
  assert.equal(tools.normalizeRoute('/api/v1/website/public/resolve-host/tenant.sites.test?x=1'), '/api/v1/website/public/resolve-host/:host');
  assert.equal(tools.percentiles([]).p95, null);
  const request = rows()[0], log = logs([request]).get(request.requestId);
  assert.equal(tools.indexServerLogs(JSON.stringify({ jsonPayload: log })).size, 1);
  assert.equal(tools.indexServerLogs(JSON.stringify({ ...log, measurementClock: 'client' })).size, 0);
});
test('missing numeric server measurements cannot turn a log envelope into a passing budget', () => {
  const requests = rows(), missing = logs(requests);
  for (const row of missing.values()) delete row.totalDurationMs;
  const result = tools.evaluateMeasurements(requests, missing);
  assert.equal(result.passed, false); assert.ok(result.endpoints[0].violations.some(message => message.includes('totalDurationMs')));
});
