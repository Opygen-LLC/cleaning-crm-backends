const path = require('node:path');
const { loadTypeScript } = require('./load-typescript.cjs');
const sourceRoot = process.env.PHASE1_SOURCE_ROOT || path.join(__dirname, '../..');
const copy = value => structuredClone(value);
const websiteId = '10000000-0000-4000-8000-000000000001';
const adminId = '20000000-0000-4000-8000-000000000002';
const userId = 'user-1';

class MemoryRedis {
  constructor() { this.values = new Map(); this.expiry = new Map(); this.writes = []; this.fail = false; }
  check() { if (this.fail) throw new Error('Redis unavailable'); }
  async get(key) {
    this.check();
    if ((this.expiry.get(key) ?? Infinity) <= Date.now()) { this.values.delete(key); this.expiry.delete(key); }
    return this.values.get(key) ?? null;
  }
  async set(key, value, ...args) {
    this.check();
    if (args.includes('NX') && await this.get(key) !== null) return null;
    let ttl = null;
    if (args.includes('PX')) ttl = Number(args[args.indexOf('PX') + 1]);
    if (args.includes('EX')) ttl = Number(args[args.indexOf('EX') + 1]) * 1000;
    this.values.set(key, String(value));
    if (ttl === null) this.expiry.delete(key); else this.expiry.set(key, Date.now() + ttl);
    this.writes.push({ key, value, ttl });
    return 'OK';
  }
  async setex(key, ttl, value) { return this.set(key, value, 'EX', ttl); }
  async del(...keys) { this.check(); let count = 0; for (const k of keys) { count += Number(this.values.delete(k)); this.expiry.delete(k); } return count; }
  async eval(script, count, ...args) {
    this.check();
    const k = args.slice(0, count), a = args.slice(count);
    if (script.includes('access:invalidate')) { await this.set(k[1], a[0]); await this.del(k[0]); return 1; }
    if (script.includes('access:cas')) {
      if (await this.get(k[1]) !== a[0]) return 0;
      await this.set(k[0], a[1], 'PX', a[2]); return 1;
    }
    if (script.includes("redis.call('INCR'")) {
      const generationKey = count === 4 ? k[3] : k[1];
      await this.set(generationKey, Number(await this.get(generationKey) ?? 0) + 1);
      await this.del(...k.filter(key => key !== generationKey)); return 1;
    }
    if (script.includes("redis.call('SET', KEYS[1], ARGV[2]")) {
      const generationKey = count === 3 ? k[2] : k[1];
      if ((await this.get(generationKey) ?? '0') !== a[0]) return 0;
      const unit = script.includes("'PX'") ? 'PX' : 'EX';
      await this.set(k[0], a[1], unit, a[2]);
      if (count === 3) await this.set(k[1], a[1], unit, a[3]);
      return 1;
    }
    if (script.includes("redis.call('DEL', KEYS[1])")) {
      return await this.get(k[0]) === a[0] ? this.del(k[0]) : 0;
    }
    throw new Error(`Unsupported Redis script in test adapter: ${script.slice(0, 120)}`);
  }
}

function fixture() {
  const redis = new MemoryRedis();
  const now = new Date();
  let website = {
    id: websiteId, adminId, subdomain: 'cleaning-test', status: 'DRAFT',
    templateId: 'clean-modern', templateVersion: '1.0.0', schemaVersion: 1,
    websiteDesign: { schemaVersion: 1, componentOverrides: {}, componentAnimations: {}, sectionStyles: {}, animationsEnabled: true },
    primaryColor: '#000000', secondaryColor: '#ffffff', accentColor: '#112233', font: null,
    logo: null, favicon: null, primaryBookingFormId: null, primaryEstimateFormId: null,
    bookingEnabled: true, bookingShowNavigation: true, bookingShowHeaderCta: true,
    bookingShowServiceCtas: true, bookingShowHomeCta: true, bookingShowAvailableSlots: true,
    bookingShowPrices: true, bookingShowStartingPrices: true, bookingShowServiceDuration: true,
    bookingCtaLabel: 'Book now', estimateEnabled: false, metaTitle: null, metaDescription: null,
    metaKeywords: [], socialImageUrl: null, indexSite: true, googleAnalyticsEnabled: false, googleAnalyticsMeasurementId: null,
    createdAt: now, updatedAt: now, publishedAt: null, publishedSnapshot: null,
    publishedRevisionNumber: null, draftRevisionNumber: 5,
    pages: ['HOME', 'BOOK'].map((kind, i) => ({ id: `page-${i}`, kind, slug: i ? 'book' : '', title: kind,
      content: {}, seoTitle: null, seoDescription: null, showInNavigation: true, isEnabled: true,
      sortOrder: i, createdAt: now, updatedAt: now })),
    domains: [], subdomainAliases: [], assets: [], primaryBookingForm: null, primaryEstimateForm: null,
  };
  let owner = {
    id: adminId, userId, businessName: 'Launch Test Cleaning', businessEmail: 'test@e2e.invalid',
    lifecycleStatus: 'ACTIVE', user: { email: 'test@e2e.invalid', status: 'ACTIVE' },
    onboardingCompletedAt: null,
    onboardingCompletedSteps: ['business_profile', 'branding', 'services', 'website_address'],
    entitlementOverride: null,
    subscription: [{ id: 'subscription-1', status: 'ACTIVE', isTrial: false,
      currentPeriodEnd: new Date(Date.now() + 60_000), trialEndsAt: null,
      plan: { id: 'pricing-1', maxStaff: 5, maxClient: 50, maxBookingsPerMonth: 500 },
      subscriptionPlan: { id: 'plan-1', name: 'STARTER', features: [] } }],
  };
  let revisions = [];
  let events = new Map();
  const operations = [];
  const controls = { failEnqueue: false, failCallback: false, failWarm: false, failImmediate: false, bookingCalls: 0 };
  const matches = (event, where) => (!where.id || where.id === event.id) &&
    (!where.status || (typeof where.status === 'string' ? event.status === where.status : where.status.in.includes(event.status))) &&
    (where.attempts === undefined || where.attempts === event.attempts);
  const db = {
    adminProfile: {
      findUnique: async () => copy({ ...owner, businessWebsite: website }),
      update: async ({ data }) => { operations.push('onboarding.write'); Object.assign(owner, copy(data)); return copy(owner); },
    },
    businessWebsite: {
      findUnique: async ({ where }) => {
        if ((where.id && where.id !== websiteId) || (where.adminId && where.adminId !== adminId) ||
            (where.subdomain && where.subdomain !== website.subdomain)) return null;
        return copy({ ...website, admin: { id: adminId, businessName: owner.businessName } });
      },
      findFirst: async () => null,
      update: async ({ data }) => { operations.push('website.write'); Object.assign(website, copy(data));
        if (data.publishedSnapshot) website.publishedDesignMetadata = { website: copy(data.publishedSnapshot.website) };
        return copy(website); },
      updateMany: async ({ where, data }) => {
        if (where.id !== website.id || (where.publicationDeliveryEventId && where.publicationDeliveryEventId !== website.publicationDeliveryEventId) ||
            (where.publishedRevisionNumber !== undefined && where.publishedRevisionNumber !== website.publishedRevisionNumber)) return { count: 0 };
        Object.assign(website, copy(data)); return { count: 1 };
      },
    },
    websiteSubdomainAlias: { findUnique: async () => null, findFirst: async () => null },
    websiteDomain: { findFirst: async () => null },
    websiteRevision: {
      aggregate: async () => ({ _max: { revisionNumber: Math.max(5, ...revisions.map(r => r.revisionNumber)) } }),
      create: async ({ data }) => { operations.push('revision.write'); const row = copy({ ...data, id: `revision-${data.revisionNumber}` }); revisions.push(row); return copy(row); },
    },
    bookingForm: { findFirst: async () => ({ id: 'booking-1' }) },
    estimateForm: { findFirst: async () => null },
    outboxEvent: {
      upsert: async ({ where, create }) => {
        operations.push('outbox.write'); if (controls.failEnqueue) throw new Error('outbox insert failed');
        if (!events.has(where.dedupeKey)) events.set(where.dedupeKey, { ...copy(create), id: create.id || `outbox-${events.size+1}`, status: 'PENDING', attempts: 0 });
        return copy(events.get(where.dedupeKey));
      },
      findUnique: async ({ where }) => copy(events.get(where.dedupeKey) ?? null),
      updateMany: async ({ where, data }) => {
        let count = 0; for (const event of events.values()) { if (matches(event, where)) { Object.assign(event, copy(data)); count++; } }
        return { count };
      },
      create: async ({ data }) => { const key = `legacy-${events.size}`; const row = { ...copy(data), id: key, status: 'PENDING', attempts: 0 }; events.set(key, row); return copy(row); },
    },
  };
  // Serialized transactional adapter with rollback, modeling the per-website
  // advisory lock. The Postgres lock itself is covered by staging/integration.
  let transactionTail = Promise.resolve();
  const prisma = { ...db, $transaction: callback => {
    const result = transactionTail.then(async () => {
      const before = copy({ website, owner, revisions, events }); operations.push('begin');
      try { const value = await callback(db); operations.push('commit'); return value; }
      catch (error) { ({ website, owner, revisions, events } = before); operations.push('rollback'); throw error; }
    });
    transactionTail = result.catch(() => {}); return result;
  } };
  const httpStatus = { NOT_FOUND: 404, CONFLICT: 409, BAD_REQUEST: 400, FORBIDDEN: 403, SERVICE_UNAVAILABLE: 503, UNPROCESSABLE_ENTITY: 422 };
  class AppError extends Error { constructor(code, message, extra) { super(message); this.statusCode = code; Object.assign(this, extra); } }
  const env = {
    WEBSITE_BASE_DOMAIN: 'sites.example.com', WEBSITE_CUSTOM_DOMAINS_ENABLED: false,
    WEBSITE_ROUTE_CACHE_TTL_SECONDS: 300, WEBSITE_ROUTE_CACHE_JITTER_RATIO: 0.2,
    WEBSITE_ROUTE_NEGATIVE_CACHE_TTL_SECONDS: 10, WEBSITE_ROUTE_REBUILD_LOCK_SECONDS: 5,
    WEBSITE_ROUTE_WAIT_FOR_FILL_MS: 0,
    WEBSITE_PROJECTION_CACHE_TTL_SECONDS: 300, WEBSITE_PROJECTION_CACHE_JITTER_RATIO: 0.2,
    WEBSITE_PROJECTION_STALE_TTL_SECONDS: 600, WEBSITE_PROJECTION_REBUILD_LOCK_SECONDS: 5,
    WEBSITE_PROJECTION_WAIT_FOR_FILL_MS: 0, WEBSITE_STUDIO_CACHE_TTL_SECONDS: 30,
    NEXT_REVALIDATE_URL: 'https://app.example.com/api/public-site/revalidate', NEXT_REVALIDATE_SECRET: 'test-only', NEXT_REVALIDATE_TIMEOUT_MS: 100,
  };
  const mocks = {
    '../../config/ENV': env, 'http-status': httpStatus,
    '../../errorHelper/AppError': AppError,
    '../../config/redis': redis,
    '../../lib/prisma/prisma': { prisma }, '../prisma/prisma': { prisma },
    '../../lib/prisma/advisoryLock': { acquireTextTransactionAdvisoryLock: async () => {} },
    '../../lib/utils/resolveAdminId': { getAdminId: async () => adminId },
    '../../lib/utils/cloudinary': {},
    '../../lib/logger': { warn() {}, info() {}, error() {} }, '../logger': { warn() {}, info() {} },
    '../monitoring/requestTrace': { getRequestTrace: () => undefined, recordTraceResponseCache: () => {}, getTracePropagationMetadata: () => ({ traceId: 'test-trace' }), traceAsyncOperation: (_k, _n, fn) => fn() },
    '../../lib/monitoring/requestTrace': { getRequestTrace: () => undefined, recordTraceResponseCache: () => {}, getTracePropagationMetadata: () => ({ traceId: 'test-trace' }), traceAsyncOperation: (_k, _n, fn) => fn() },
    '../../lib/utils/subscriptionPlanFeatures': { normalizeSubscriptionPlanFeatures: v => v ?? [] },
    './featureCatalog': { FEATURE_KEYS: ['website', 'online_booking', 'custom_domain'], featureParent: () => null },
    '../SuperAdmin/tenantEntitlement.service': {
      isOverrideActive: (v, now = new Date()) => Boolean(v && (!v.expiresAt || v.expiresAt > now)),
      readFeatureOverrides: v => v || {}, readResourceOverrides: v => v || {}, applyNumericResourceOverride: v => v,
    },
    '../Admin/admin.constant': { ONBOARDING_STEPS: ['business_profile','branding','services','website_address','review_launch'].map(key => ({ key })) },
    './websiteIdentity': { normalizeSubdomain: v => v.trim().toLowerCase(), assertSafeHttpsUrl: v => v },
    './websiteDomainReadiness': { readyWebsiteDomainWhere: {}, isWebsiteDomainRoutingReady: () => false },
    './websiteDomainLifecycle': { presentWebsiteDomain: v => v },
    './websiteCanonicalHost': { getCanonicalWebsiteHost: (subdomain, primaryCustomHost) => primaryCustomHost || `${subdomain}.sites.example.com` },
    './templateRegistry': { TemplateRegistry: { requireTemplate: () => ({ id: 'clean-modern', version: '1.0.0', schemaVersion: 1, tier: 'FREE' }), requirePublishable: () => ({ id: 'clean-modern', version: '1.0.0', schemaVersion: 1, tier: 'FREE' }) } },
    './templateSelection': {}, './websiteProvisioning.service': { WebsiteProvisioningService: {} },
    './websiteBookingProvisioning.service': { WebsiteBookingProvisioningService: { ensureAttachedForLaunchTx: async tx => {
      controls.bookingCalls++; await tx.businessWebsite.update({ where: { id: websiteId }, data: { primaryBookingFormId: 'booking-1' } }); return 'booking-1';
    } } },
    './websiteSnapshot': {
      buildPublishedSnapshot: draft => ({ version: 1, website: copy(draft), pages: copy(draft.pages) }),
      parsePublishedSnapshot: v => v || null, parsePublishedDesignMetadata: v => v || null, buildWebsitePublicationFingerprint: () => null, parseRevisionSnapshotAsPublished: v => v,
    },
    './websiteContent': { validateWebsitePageContent: (_kind, value) => value },
    './websiteDesignContract': { parseWebsiteDesignContract: v => v },
    './websiteComponentRegistry': { assertWebsiteDesignPublishable: () => {} },
    './website.interface': { WEBSITE_EDITOR_SURFACES: ['content','templates','branding','booking','seo','domain','analytics','history'] },
    '../../lib/cache/resourceCacheVersion': { CacheResource: { website: 'website' }, bumpCacheResourceVersions: async () => {} },
  };
  const cache = new Map();
  const load = relative => loadTypeScript(path.join(sourceRoot, 'src', relative), mocks, cache);
  const access = load('modules/Entitlement/tenantAccessResolver.service.ts').TenantAccessResolver;
  mocks['../Entitlement/tenantAccessResolver.service'] = { TenantAccessResolver: access };
  const entitlements = { advancedSeo: true, customDomains: false, freeSubdomain: true, basicWebsite: true, onlineBooking: true };
  mocks['./websiteEntitlement.service'] = { WebsiteEntitlementService: { getForAdminId: async () => entitlements, fromAccess: a => ({ ...entitlements, customDomains: a.effectiveEntitlements.custom_domain }), assertTemplateAllowed() {} } };
  const outbox = load('lib/outbox/publicWebsiteCacheOutbox.ts');
  outbox.PublicWebsiteCacheRevalidation.deliver = async () => { operations.push('next.callback'); if (controls.failCallback) throw new Error('Next timed out'); };
  outbox.PublicWebsiteCacheRevalidation.triggerWithFallback = async () => ({ configured: true, delivered: !controls.failCallback, queued: controls.failCallback });
  mocks['../../lib/outbox/publicWebsiteCacheOutbox'] = outbox;
  const host = load('modules/Website/websiteHostResolver.service.ts').WebsiteHostResolverService;
  const projection = load('modules/Website/websiteProjectionCache.service.ts').WebsiteProjectionCacheService;
  mocks['./websiteHostResolver.service'] = { WebsiteHostResolverService: host };
  mocks['./websiteProjectionCache.service'] = { WebsiteProjectionCacheService: projection };
  const publicWebsite = { getPublicWebsiteById: async id => {
    const decision = await access.resolve(adminId);
    if (!decision.access.publicWebsiteAllowed) throw new Error('Public access denied');
    const loader = async () => ({ website: { id, subdomain: website.subdomain, publishedRevisionNumber: website.publishedRevisionNumber } });
    return controls.failWarm ? loader() : projection.getOrLoad(id, loader, decision);
  } };
  mocks['./publicWebsite.service'] = { PublicWebsiteService: publicWebsite };
  let delivery;
  if (!process.env.PHASE1_SOURCE_ROOT) {
    delivery = load('modules/Website/websitePublicationDelivery.service.ts').WebsitePublicationDeliveryService;
    const immediate = delivery.attemptImmediate;
    delivery.attemptImmediate = async event => { if (controls.failImmediate) throw new Error('Simulated response timeout after COMMIT'); return immediate(event); };
    mocks['./websitePublicationDelivery.service'] = { WebsitePublicationDeliveryService: delivery };
  }
  const service = load('modules/Website/website.service.ts').WebsiteService;
  return { service, access, host, projection, outbox, delivery, publicWebsite, redis, db, prisma, controls, operations,
    state: () => ({ website, owner, revisions, events }), websiteId, adminId, userId,
    launch: payload => service.launchWebsite(payload ?? {}, { id: userId }),
  };
}
module.exports = { fixture, MemoryRedis, websiteId, adminId, userId };
