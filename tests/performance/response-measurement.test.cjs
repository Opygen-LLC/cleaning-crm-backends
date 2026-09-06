const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
async function measure(handler, method = 'GET') {
  let trace, stringifyCalls = 0;
  const logs = [], metrics = [];
  const middleware = loadTypeScript(path.resolve('src/middlewares/logger.middleware.ts'), {
    '../config/ENV': { NODE_ENV: 'production', SLOW_REQUEST_THRESHOLD_MS: 1000 },
    '../lib/logger': { warn() {}, log(level, message, data) { if (data) logs.push(data); } },
    '../lib/monitoring/performanceMetrics': { recordRequestMetric: value => metrics.push(value) },
    '../lib/monitoring/requestTrace': { getRequestTrace: () => trace },
    '../lib/monitoring/requestGeography': { resolveRequestGeography: () => ({ market: 'unknown', source: 'unknown' }) },
    '../lib/monitoring/requestStormDetector': { observeRequestStorm: () => null },
    '../lib/monitoring/queryBudgets': { evaluateEndpointQueryBudget: () => null, getEndpointQueryBudget: () => 12 },
  }).default;
  const server = http.createServer((req, res) => {
    trace = { startedAtNs: process.hrtime.bigint(), requestId: 'test-request', traceId: 'test-trace', dbQueryCount: 2, dbDurationMs: 3, redisDurationMs: 2, dbPoolWaitMs: 1, dbPoolAcquisitions: 1, dbPoolErrors: 0, serializationDurationMs: 0, authDurationMs: 1, queueDurationMs: 0, externalDurationMs: 0 };
    Object.assign(req, { path: '/api/v1/website/editor', originalUrl: req.url, route: { path: '/api/v1/website/editor' } }); res.locals = {};
    res.send = function(body) { this.end(body); return this; };
    // Express json's actual contract: stringify once, then call send(string).
    res.json = function(body) { stringifyCalls++; return this.send(JSON.stringify(body)); };
    middleware(req, res, () => handler(res));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/website/editor`, { method });
    const body = await response.text();
    await new Promise(resolve => setImmediate(resolve));
    return { body, headers: response.headers, logs, metrics, stringifyCalls, trace };
  } finally { await new Promise(resolve => server.close(resolve)); server.closeAllConnections(); }
}
test('response instrumentation measures real JSON serialization once and exact bytes', async () => {
  let toJSON = 0;
  const result = await measure(res => res.json({ toJSON() { toJSON++; return { name: 'clean', count: 2 }; } }));
  assert.equal(toJSON, 1); assert.equal(result.stringifyCalls, 1); assert.equal(result.logs.length, 1);
  const log = result.logs[0]; assert.equal(log.responseBytes, Buffer.byteLength(result.body));
  assert.equal(log.measurementClock, 'api-middleware-to-finish'); assert.equal(log.dbPoolAcquisitions, 1);
  assert.ok(log.totalDurationMs >= 0); assert.equal(result.trace.closed, true);
  assert.match(result.headers.get('server-timing'), /API middleware to response headers/);
});
test('streaming includes all chunks; finish and response-header clocks remain distinct', async () => {
  const result = await measure(res => { res.writeHead(200); res.write('hello'); setTimeout(() => res.end(' world'), 40); });
  assert.equal(result.body, 'hello world'); assert.equal(result.logs[0].responseBytes, 11);
  const headersMs = Number(result.headers.get('server-timing').match(/app;dur=([0-9.]+)/)[1]);
  assert.ok(result.logs[0].totalDurationMs >= headersMs + 25);
});
test('HEAD and no-content responses do not count unsent payload bytes', async () => {
  const head = await measure(res => res.json({ never: 'sent' }), 'HEAD');
  assert.equal(head.body, ''); assert.equal(head.logs[0].responseBytes, 0);
  const noContent = await measure(res => { res.statusCode = 204; res.end('not-sent'); });
  assert.equal(noContent.logs[0].responseBytes, 0);
});
