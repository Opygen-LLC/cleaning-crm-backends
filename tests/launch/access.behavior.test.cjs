const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');

function fixture() {
  const values = new Map();
  const writes = [];
  let websiteStatus = 'DRAFT';
  let holdRead;
  let holdOnce = false;
  const tenant = () => ({
    id: 'admin-1', userId: 'user-1', lifecycleStatus: 'ACTIVE', user: { status: 'ACTIVE' },
    businessWebsite: { status: websiteStatus }, entitlementOverride: null,
    subscription: [{ id: 'sub-1', status: 'ACTIVE', isTrial: false,
      currentPeriodEnd: new Date(Date.now() + 60_000), extraStaff: 0, extraClient: 0, extraBookingsPerMonth: 0,
      plan: { id: 'price-1', maxStaff: 5, maxClient: 5, maxBookingsPerMonth: 5 },
      subscriptionPlan: { id: 'plan-1', name: 'STARTER', features: [] } }],
  });
  const redis = {
    get: async key => values.get(key) ?? null,
    set: async (key, value, ...args) => { if (args.includes('NX') && values.has(key)) return null; values.set(key, value); return 'OK'; },
    setex: async (key, ttl, value) => { values.set(key, value); writes.push({ key, value, ttl }); return 'OK'; },
    del: async (...keys) => { keys.forEach(key => values.delete(key)); return 1; },
    eval: async (script, count, ...args) => {
      const keys = args.slice(0, count); const argv = args.slice(count);
      if (script.includes('access:invalidate')) { values.set(keys[1], argv[0]); values.delete(keys[0]); return 1; }
      if (script.includes('access:cas')) {
        if (values.get(keys[1]) !== argv[0]) return 0;
        values.set(keys[0], argv[1]); writes.push({ key: keys[0], value: argv[1], ttlMs: Number(argv[2]) }); return 1;
      }
      throw new Error('Unexpected Redis script');
    },
  };
  const prisma = { adminProfile: { findUnique: async () => {
    const snapshot = tenant();
    if (holdOnce) { holdOnce = false; await new Promise(resolve => { holdRead = resolve; }); }
    return snapshot;
  } } };
  const module = loadTypeScript(path.join(__dirname, '../../src/modules/Entitlement/tenantAccessResolver.service.ts'), {
    '../../config/redis': { default: redis, __esModule: true },
    '../../lib/prisma/prisma': { prisma },
    'http-status': { default: { NOT_FOUND: 404, SERVICE_UNAVAILABLE: 503 }, __esModule: true },
    '../../errorHelper/AppError': { default: class extends Error { constructor(code, message, extras) { super(message); this.statusCode = code; Object.assign(this, extras); } }, __esModule: true },
    '../../lib/utils/subscriptionPlanFeatures': { normalizeSubscriptionPlanFeatures: value => value || [] },
    './featureCatalog': { FEATURE_KEYS: ['website', 'online_booking', 'custom_domain'], featureParent: () => null },
    '../SuperAdmin/tenantEntitlement.service': {
      isOverrideActive: v => Boolean(v && (!v.expiresAt || v.expiresAt > new Date())),
      readFeatureOverrides: v => v || {}, readResourceOverrides: v => v || {},
      applyNumericResourceOverride: v => v,
    },
  });
  return { module, redis, values, writes, publish: () => { websiteStatus = 'PUBLISHED'; },
    hold: () => { holdOnce = true; }, release: async () => { while (!holdRead) await new Promise(resolve => setImmediate(resolve)); holdRead(); } };
}

test('regression 1: an in-flight DRAFT lookup cannot refill access after launch invalidation', async () => {
  const f = fixture();
  f.hold();
  const stale = f.module.TenantAccessResolver.resolve('admin-1');
  await new Promise(resolve => setImmediate(resolve));
  f.publish();
  await f.module.TenantAccessResolver.invalidate('admin-1');
  await f.release();
  await stale;
  const actual = await f.module.TenantAccessResolver.resolve('admin-1');
  assert.equal(actual.access.publicWebsiteAllowed, true);
});

test('authorization expires at the exact trial/period boundary, not a second later', () => {
  const f = fixture(); const boundary = new Date('2026-09-06T12:00:00.000Z');
  assert.equal(f.module.evaluateTenantAccess({ lifecycleStatus: 'ACTIVE', ownerStatus: 'ACTIVE',
    subscriptionStatus: 'ACTIVE', isTrial: true, trialEndsAt: boundary, now: boundary }).deniedReason, 'TRIAL_EXPIRED');
});

test('Redis invalidation failure is reported as failure, never confirmed delivery', async () => {
  const f = fixture(); f.redis.eval = async () => { throw new Error('Redis unavailable'); };
  f.redis.del = async () => { throw new Error('Redis unavailable'); };
  assert.equal(await f.module.TenantAccessResolver.invalidate('admin-1'), false);
});
