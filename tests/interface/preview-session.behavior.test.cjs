const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const status = { CONFLICT: 409, BAD_REQUEST: 400, SERVICE_UNAVAILABLE: 503, NOT_FOUND: 404, GONE: 410 };
const expected = { websiteId: 'website-a', draftRevisionNumber: 7, profileVersion: 'a'.repeat(64) };
const user = { id: 'owner-a', role: 'ADMIN' };
const projection = () => ({ website: { id: 'website-a', preview: true, draftRevisionNumber: 7, previewProfileVersion: expected.profileVersion, previewContractVersion: 1 }, business: { name: 'Private saved business' }, googleAnalytics: { enabled: false, measurementId: null } });
const { validPreviewEnvelope, assertPreviewExpectation } = loadTypeScript(path.join(__dirname, '../../src/modules/Website/websitePreviewContract.ts'), { 'http-status': status });
function fixture() {
  const state = { data: new Map(), writes: [], gets: [], reads: 0, projection: projection(), redisFailure: false,
    website: { id: 'website-a', adminId: 'tenant-a', admin: { lifecycleStatus: 'ACTIVE', user: { id: 'owner-a', status: 'ACTIVE' } } } };
  const redis = {
    async set(key, value, ex, seconds, nx) { if (state.redisFailure) throw new Error('offline'); state.writes.push({ key, ex, seconds, nx }); state.data.set(key, value); return 'OK'; },
    async get(key) { if (state.redisFailure) throw new Error('offline'); state.gets.push(key); return state.data.get(key) ?? null; },
  };
  const mocks = { 'http-status': status, '../../config/redis': redis,
    '../../lib/prisma/prisma': { prisma: { businessWebsite: { async findUnique() { state.reads++; return state.website; } } } },
    '../../lib/utils/resolveAdminId': { getAdminId: async () => 'tenant-a' },
    './publicWebsite.service': { PublicWebsiteService: { async getPreviewWebsite() { return state.projection; }, async getEditorStatePreviewWebsite() { return state.projection; } } },
  };
  const service = loadTypeScript(path.join(__dirname, '../../src/modules/Website/websitePreviewSession.service.ts'), mocks).WebsitePreviewSessionService;
  return { state, service };
}
const errorStatus = number => error => error?.statusCode === number;

test('saved preview expectation rejects stale revisions, profiles and tenants before issuing a token', async () => {
  for (const patch of [{ id: 'other' }, { draftRevisionNumber: 8 }, { previewProfileVersion: 'other' }, { preview: false }]) {
    const { service, state } = fixture(); Object.assign(state.projection.website, patch);
    await assert.rejects(service.create(user, { expected }), errorStatus(409)); assert.equal(state.writes.length, 0);
  }
});

test('legacy Studio preview still accepts editor overrides but saved preview cannot claim overrides are persisted', async () => {
  const { service, state } = fixture();
  await assert.rejects(service.create(user, { expected, website: { primaryColor: '#111111' } }), errorStatus(400));
  assert.equal(state.writes.length, 0);
  assert.match((await service.create(user, { website: { primaryColor: '#111111' } })).previewToken, /^[A-Za-z0-9_-]{43}$/);
});

test('secure preview uses a hashed random bearer, ten-minute TTL and atomic NX delivery acknowledgement', async () => {
  const { service, state } = fixture(); const first = await service.create(user, { expected });
  const second = await service.create(user, { expected });
  assert.notEqual(first.previewToken, second.previewToken);
  const write = state.writes[0];
  assert.equal(write.ex, 'EX'); assert.equal(write.seconds, 600); assert.equal(write.nx, 'NX');
  assert.equal(write.key, `website:preview-session:v1:${createHash('sha256').update(first.previewToken).digest('hex')}`);
  assert.ok(!write.key.includes(first.previewToken));
  assert.equal(first.websiteId, expected.websiteId); assert.equal(first.draftRevisionNumber, 7); assert.equal(first.previewContractVersion, 1);
  const served = await service.get(first.previewToken);
  assert.deepEqual(served, state.projection); assert.equal(state.reads, 1);
});

test('Redis outage is not represented as confirmed preview readiness', async () => {
  const { service, state } = fixture(); state.redisFailure = true;
  await assert.rejects(service.create(user, { expected }), errorStatus(503));
  await assert.rejects(service.get('a'.repeat(43)), errorStatus(503));
});

test('malformed or expired bearer never reaches tenant projection reads', async () => {
  const { service, state } = fixture();
  await assert.rejects(service.get('../guess'), errorStatus(404));
  assert.equal(state.gets.length, 0);
  await assert.rejects(service.get('a'.repeat(43)), errorStatus(410));
  const result = await service.create(user, { expected }); const key = state.writes[0].key;
  for (const date of ['not-a-date', new Date(0).toISOString()]) {
    const envelope = JSON.parse(state.data.get(key)); envelope.expiresAt = date;
    state.data.set(key, JSON.stringify(envelope));
    await assert.rejects(service.get(result.previewToken), errorStatus(410));
  }
  assert.equal(state.reads, 0);
});

test('suspension, account disablement, deletion and reassignment revoke already issued bearer previews', async () => {
  for (const revoke of [s => { s.website.admin.lifecycleStatus = 'SUSPENDED'; }, s => { s.website.admin.user.status = 'INACTIVE'; }, s => { s.website = null; }, s => { s.website.adminId = 'tenant-b'; }, s => { s.website.admin.user.id = 'new-owner'; }]) {
    const { service, state } = fixture(); const issued = await service.create(user, { expected }); revoke(state);
    await assert.rejects(service.get(issued.previewToken), errorStatus(410));
  }
});

test('envelope validity rejects immortal dates, future issuance, excessive TTL and identity mismatches', () => {
  const now = Date.now();
  const valid = { version: 1, websiteId: 'website-a', adminId: 'tenant-a', createdBy: 'owner-a', createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 599000).toISOString(), projection: projection() };
  assert.equal(validPreviewEnvelope(valid, now, 600), true);
  for (const patch of [{ version: 2 }, { adminId: '' }, { expiresAt: 'NaN' }, { createdAt: new Date(now + 1).toISOString() }, { expiresAt: new Date(now + 600001).toISOString() }, { websiteId: 'other' }, { projection: { website: { id: 'website-a', preview: false } } }]) {
    assert.equal(validPreviewEnvelope({ ...valid, ...patch }, now, 600), false);
  }
  assert.doesNotThrow(() => assertPreviewExpectation(projection(), undefined));
});
