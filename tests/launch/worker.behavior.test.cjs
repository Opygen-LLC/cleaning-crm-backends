const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('../helpers/launch-fixture.cjs');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');

function workerFor(f, onDelivery) {
  const metrics = [], writes = [];
  let claimed;
  const prisma = { ...f.prisma,
    $queryRaw: async () => {
      const event = [...f.state().events.values()][0];
      event.status = 'PROCESSING'; event.attempts += 1;
      claimed = structuredClone(event); return [claimed];
    },
    outboxEvent: { ...f.db.outboxEvent, updateMany: async input => {
      writes.push(structuredClone(input)); return f.db.outboxEvent.updateMany(input);
    } },
  };
  const mocks = {
    '../lib/auth': { auth: { api: {} } }, '../lib/email': { sendEmail() {} },
    '../lib/logger': { info() {}, warn() {}, error() {} }, '../lib/prisma/prisma': { prisma },
    '../config/ENV': { NODE_ENV: 'test', OUTBOX_LOCK_TIMEOUT_MS: 30_000, OUTBOX_WORKER_BATCH_SIZE: 10,
      OUTBOX_WORKER_ENABLED: false, OUTBOX_WORKER_POLL_MS: 1000 },
    '../lib/monitoring/requestTrace': { getRequestTrace: () => null, runWithRequestTrace: (_trace, fn) => fn(), traceAsyncOperation: (_kind, _name, fn) => fn() },
    '../lib/outbox/authEmailOutbox': { AUTH_EMAIL_OUTBOX_TOPIC: { EMAIL_VERIFICATION_REQUESTED: 'AUTH_EMAIL_VERIFICATION_REQUESTED' } },
    '../lib/outbox/publicWebsiteCacheOutbox': f.outbox,
    '../lib/outbox/businessNotificationOutbox': { BUSINESS_NOTIFICATION_OUTBOX_TOPIC: { DELIVERY_REQUESTED: 'BUSINESS_NOTIFICATION_DELIVERY_REQUESTED' } },
    '../lib/notifications/businessNotificationRegistry': { BUSINESS_NOTIFICATION_REGISTRY: {}, isBusinessNotificationTemplateKey: () => false },
    '../modules/Website/websitePublicationDelivery.service': { WebsitePublicationDeliveryService: {
      recordReceipt: f.delivery.recordReceipt,
      deliver: async payload => { const outcome = await f.delivery.deliver(payload); if (onDelivery) onDelivery(); return outcome; },
    } },
    '../modules/Entitlement/tenantAccessResolver.service': { TenantAccessResolver: f.access },
    '../lib/monitoring/emailOutboxHealth': { recordEmailOutboxSuccessfulDelivery: async () => {}, recordEmailOutboxWorkerHeartbeat: async () => {} },
    '../lib/monitoring/operationalMetrics': { recordNotificationDelivery() {}, recordSmtpDelivery() {}, recordOutboxOutcome: (...args) => metrics.push(args) },
  };
  const worker = loadTypeScript(path.resolve(__dirname, '../../src/workers/emailOutbox.worker.ts'), mocks);
  return { ...worker, metrics, writes, claimed: () => claimed };
}

test('actual outbox worker recovers the same transactional publication row and persists a truthful receipt', async () => {
  const f = fixture(); f.controls.failCallback = true; await f.launch(); f.controls.failCallback = false;
  const worker = workerFor(f);
  assert.deepEqual(await worker.processEmailOutboxOnce(), { claimed: 1 });
  const event = [...f.state().events.values()][0];
  assert.equal(event.status, 'PROCESSED');
  assert.equal(event.payload.receipt.ready, true);
  assert.equal(event.payload.receipt.revalidationQueued, false);
  assert.equal(f.state().events.size, 1);
  assert.equal(f.state().revisions.length, 1);
  for (const write of worker.writes) assert.deepEqual(write.where, { id: event.id, status: 'PROCESSING', attempts: 1 });
});

test('actual worker keeps a warming failure retryable rather than acknowledging readiness', async () => {
  const f = fixture(); f.controls.failWarm = true; await f.launch();
  const worker = workerFor(f); await worker.processEmailOutboxOnce();
  const event = [...f.state().events.values()][0];
  assert.equal(event.status, 'RETRY');
  assert.match(event.lastError, /WARMING_UNCONFIRMED/);
  assert.equal(worker.metrics[0][1], 'retry');
});

test('an expired worker lease cannot acknowledge, overwrite or emit success for the newer claimant', async () => {
  const f = fixture(); f.controls.failCallback = true; await f.launch(); f.controls.failCallback = false;
  const worker = workerFor(f, () => { const event = [...f.state().events.values()][0]; event.attempts += 1; });
  await worker.processEmailOutboxOnce();
  const event = [...f.state().events.values()][0];
  assert.equal(event.status, 'PROCESSING'); assert.equal(event.attempts, 2);
  assert.equal(worker.metrics.length, 0);
});
