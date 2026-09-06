const path = require('node:path');
const { fixture: launchFixture } = require('./launch-fixture.cjs');
const { loadTypeScript } = require('./load-typescript.cjs');
const copy = value => structuredClone(value);
const root = path.join(__dirname, '../..');
const enums = {
  ServiceStatus: { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' },
  ServiceCategory: { RESIDENTIAL: 'RESIDENTIAL', COMMERCIAL: 'COMMERCIAL', SPECIALIST: 'SPECIALIST' },
  SubscriptionStatus: { ACTIVE: 'ACTIVE' }, AccountStatus: { ACTIVE: 'ACTIVE' },
};
const status = { NOT_FOUND: 404, CONFLICT: 409, BAD_REQUEST: 400, FORBIDDEN: 403, UNPROCESSABLE_ENTITY: 422 };
const serviceId = index => `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const serviceRow = (index, adminId) => ({
  id: serviceId(index), adminId, serviceName: `Service ${index}`, slug: `service-${index}`,
  description: `Description ${index}`, basePrice: 50 + index, duration: '2h', category: 'RESIDENTIAL',
  status: 'ACTIVE', onlineBookingEnabled: true, addOns: [{ name: 'Oven', price: 15 }],
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), legacyServiceType: null,
});
function fixture({ catalogSize = 1, completed = ['business_profile', 'branding'] } = {}) {
  const f = launchFixture();
  const { db, operations, adminId, userId, websiteId } = f;
  const owner = f.state().owner;
  Object.assign(owner, {
    mobileNumber: '+447700900123', businessDescription: 'Existing description', address: 'Existing address',
    city: 'London', zipcode: 'SW1A 1AA', currency: 'GBP', businessHours: null,
    updatedAt: new Date('2026-01-01'), onboardingCompletedSteps: [...completed],
    user: { id: userId, role: 'ADMIN', status: 'ACTIVE' },
  });
  let rows = Array.from({ length: catalogSize }, (_, index) => serviceRow(index + 1, adminId));
  let booking = {
    enabled: true, live: false, primaryBookingFormId: null, primaryBookingForm: null,
    publishedForms: [], publishedFormCount: 0, bookableServiceCount: catalogSize,
    requiresSelection: false, canCreateDefault: true, websitePath: '/book',
    estimate: { enabled: false, live: false, primaryEstimateFormId: null, primaryEstimateForm: null, publishedForms: [], websitePath: '/estimate' },
    settings: { showNavigation: true, showHeaderCta: true, showServiceCtas: true, showHomeCta: true,
      showAvailableSlots: false, showPrices: true, showStartingPrices: true, showServiceDuration: true, ctaLabel: 'Book Now' },
  };
  const controls = { failBooking: false, failRevision: false, failCache: false };
  const assets = new Map();
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    if (value && typeof value === 'object' && 'startsWith' in value) return row[key].startsWith(value.startsWith);
    return row[key] === value;
  });
  const selectRow = (row, select) => select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, copy(row[k])])) : copy(row);
  db.adminProfile.findUniqueOrThrow = async args => { const row = await db.adminProfile.findUnique(args); if (!row) throw new Error('Owner missing'); return row; };
  db.businessWebsite.findUniqueOrThrow = async args => { const row = await db.businessWebsite.findUnique(args); if (!row) throw new Error('Website missing'); return row; };
  db.businessWebsite.findFirst = async ({ where }) => where.adminId === adminId && where.id === websiteId ? copy(f.state().website) : null;
  db.websiteAsset = { findFirst: async ({ where }) => copy(assets.get(`${where.websiteId}:${where.url}`) ?? null) };
  db.websiteRevision.findFirst = async ({ where }) => copy(f.state().revisions.find(r => matches(r, where)) ?? null);
  const createRevision = db.websiteRevision.create;
  db.websiteRevision.create = async arg => { if (controls.failRevision) throw new Error('revision write failed'); return createRevision(arg); };
  db.$queryRaw = async strings => { operations.push(strings.join('').includes('FOR UPDATE') ? 'owner.lock' : 'optional.read'); return []; };
  db.serviceCatalog = {
    findMany: async ({ where, select, take } = {}) => rows.filter(r => matches(r, where)).sort((a,b) => a.id.localeCompare(b.id)).slice(0, take ?? rows.length).map(r => selectRow(r, select)),
    findFirst: async ({ where } = {}) => copy(rows.find(r => matches(r, where)) ?? null),
    count: async ({ where } = {}) => rows.filter(r => matches(r, where)).length,
    create: async ({ data }) => { const r = { ...serviceRow(rows.length + 1, adminId), ...copy(data), updatedAt: new Date() }; rows.push(r); return copy(r); },
    update: async ({ where, data }) => { const r = rows.find(row => matches(row, where)); if (!r) throw new Error('service missing'); Object.assign(r, copy(data), { updatedAt: new Date() }); return copy(r); },
    updateMany: async ({ where, data }) => { let count = 0; for (const r of rows) if (matches(r, where)) { Object.assign(r, copy(data), { updatedAt: new Date() }); count++; } return { count }; },
    delete: async ({ where }) => { const r = rows.find(row => matches(row, where)); rows = rows.filter(row => !matches(row, where)); return copy(r); },
  };
  // Explicit I/O adapter: serialized transaction with rollback for catalog and
  // booking as well as the original website/owner/revision tables. This does
  // NOT claim to exercise PostgreSQL advisory locks or the Prisma driver.
  const prisma = { ...db, $transaction: callback => f.prisma.$transaction(async tx => {
    const before = copy({ rows, booking });
    try { return await callback(tx); } catch (error) { ({ rows, booking } = before); throw error; }
  }) };
  const invalidate = async () => { if (controls.failCache) throw new Error('cache unavailable'); };
  const mocks = {
    'http-status': status, 'date-fns': { startOfMonth: v => v },
    '../../contracts/apiContract': { API_CONTRACT: { onboardingStep: ['business_profile','branding','services','website_address','review_launch'] } },
    '../../generated/prisma/enums': enums, '../../generated/prisma/client': { Prisma: { DbNull: null } },
    '../../lib/prisma/prisma': { prisma },
    '../../lib/prisma/advisoryLock': {
      acquireTextTransactionAdvisoryLock: async (_tx, id) => operations.push(`website.lock:${id}`),
      acquireExtendedTextTransactionAdvisoryLock: async (_tx, key) => operations.push(key),
    },
    '../../config/redis': { del: invalidate },
    '../../lib/logger': { warn() {}, error() {}, info() {} },
    '../../config/ENV': { RELEASE_VERSION: 'test', WEBSITE_BASE_DOMAIN: 'sites.example.com' },
    '../../lib/validation/phone': { normalizeOptionalE164Phone: v => v, requireE164Phone: v => v },
    '../../lib/constants/countryIsoMap': {}, '../../lib/monitoring/errorMonitor': { ErrorMonitor: {} },
    '../../lib/monitoring/productReliabilityMetrics': { recordClientReliabilitySignals() {}, recordProductReliabilitySignal() {} },
    '../../lib/cache/resourceCacheVersion': { CacheResource: { onboarding: 'onboarding', profile: 'profile', website: 'website', dashboard: 'dashboard' }, bumpCacheResourceVersions: invalidate },
    '../../lib/utils/resolveAdminId': { getAdminId: async () => adminId },
    '../../lib/utils/serviceIdentity': { inferLegacyServiceType: () => null },
    '../BookingForm/bookingForm.cache': { invalidateBookingFormsForAdmin: invalidate },
    '../../lib/cache/cachePolicy': { CacheNamespaces: { serviceCatalog: v => v }, CacheTtl: {}, ttlForKey: () => 30 },
    '../Website/website.service': { WebsiteService: f.service },
    '../Website/websiteProjectionCache.service': { WebsiteProjectionCacheService: { invalidateStudioAdmin: invalidate, invalidateAdminWebsite: invalidate } },
    '../Website/websiteCanonicalHost': { getCanonicalWebsiteOrigin: subdomain => `https://${subdomain}.sites.example.com` },
    '../Website/subdomain.service': { SubdomainService: {
      renameForWebsiteTx: async (tx, id, subdomain) => { await tx.businessWebsite.update({ where: { id }, data: { subdomain } }); return { subdomain }; },
      deliverRename: invalidate,
    } },
    // HTTP validation is tested independently against real Zod 4 in Vitest.
    // These dependency-light behavior tests exercise already-parsed payloads.
    './onboardingSave.contract': { onboardingStepSaveSchema: { parse: copy } },
    './businessHours': { businessHoursSchema: { safeParse: v => ({ success: true, data: v }) }, normalizeBusinessHours: copy },
    '../Website/websiteBookingProvisioning.service': { WebsiteBookingProvisioningService: {
      getSetupByAdminId: async () => copy(booking),
      configureForAdminTx: async (tx, id, input) => {
        if (controls.failBooking) throw new Error('booking configuration rejected');
        if (input.bookingFormId === 'foreign-form') throw new Error('booking form belongs to another tenant');
        const { enabled, bookingFormId, ...settings } = input;
        booking = { ...booking, enabled, primaryBookingFormId: bookingFormId ?? null, settings: copy(settings) };
        await tx.businessWebsite.update({ where: { adminId: id }, data: { bookingEnabled: input.enabled } });
      },
    } },
  };
  const cache = new Map();
  const load = relative => loadTypeScript(path.join(root, 'src', relative), mocks, cache);
  const concurrency = load('modules/ServiceCatalog/serviceCatalogConcurrency.ts');
  const catalog = load('modules/ServiceCatalog/serviceCatalog.service.ts');
  const admin = load('modules/Admin/admin.service.ts').adminService;
  const progress = load('modules/Admin/onboardingProgress.ts');
  const service = load('modules/Admin/onboardingSave.service.ts').OnboardingSaveService;
  return { ...f, service, catalog, concurrency, progress, admin, prisma, controls, assets,
    rows: () => rows, booking: () => booking,
    profilePayload: async (profile = {}) => ({ schemaVersion: 2, websiteId, step: 'business_profile', expectedRevisionNumber: f.state().website.draftRevisionNumber, expectedProfileVersion: (await admin.getOnboardingBootstrap(adminId, db)).profileVersion, profile }),
    servicesPayload: async (services = [], deactivateServiceCatalogIds = []) => ({ schemaVersion: 2, websiteId, step: 'services', expectedRevisionNumber: f.state().website.draftRevisionNumber, catalogVersion: (await concurrency.readOnboardingCatalogTx(db, adminId)).version, services, deactivateServiceCatalogIds, booking: { ...copy(booking.settings), enabled: booking.enabled, bookingFormId: booking.primaryBookingFormId } }),
  };
}
module.exports = { fixture, serviceRow, serviceId };
