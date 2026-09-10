const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, serviceId } = require('../helpers/onboarding-fixture.cjs');
const copy = v => structuredClone(v);
const servicePatch = (row, changes = {}) => ({ serviceCatalogId: row.id, serviceName: row.serviceName, description: row.description, basePrice: row.basePrice, duration: row.duration, category: row.category, onlineBookingEnabled: row.onlineBookingEnabled, ...changes });

test('profile clears are persisted; omitted currency/hours/phone are unchanged; response is the committed read', async () => {
  const f = fixture({ completed: [] });
  const result = await f.service.saveStep(f.userId, await f.profilePayload({ businessEmail: null, businessDescription: null, address: null, city: null, postcode: null }));
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.bootstrap.profile.businessEmail, null);
  assert.equal(result.bootstrap.profile.postcode, null);
  assert.equal(result.bootstrap.profile.mobileNumber, '+447700900123');
  assert.equal(result.bootstrap.profile.currency, 'GBP');
  assert.equal(result.draftRevisionNumber, 6);
  assert.equal(result.bootstrap.website.draftRevisionNumber, 6);
  assert.deepEqual(result.bootstrap.onboarding.completedSteps, ['business_profile']);
  assert.equal(result.nextStep, 'branding');
  const reloaded = await f.admin.getOnboardingBootstrap(f.adminId, f.db);
  assert.deepEqual(reloaded.profile, result.bootstrap.profile);
  assert.equal(reloaded.profileVersion, result.bootstrap.profileVersion);
});

test('business hours retain the saved timezone and explicit null removes the entire value', async () => {
  const f = fixture();
  const hours = Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day => [day, { isOpen: true, opensAt: '09:00', closesAt: '17:00' }]));
  f.state().owner.businessHours = { ...copy(hours), timezone: 'Asia/Dhaka' };
  hours.monday.closesAt = '18:00';
  const first = await f.service.saveStep(f.userId, await f.profilePayload({ businessHours: hours }));
  assert.equal(first.bootstrap.profile.businessHours.timezone, 'Asia/Dhaka');
  assert.equal(first.bootstrap.profile.businessHours.monday.closesAt, '18:00');
  const cleared = await f.service.saveStep(f.userId, await f.profilePayload({ businessHours: null }));
  assert.equal(cleared.bootstrap.profile.businessHours, null);
});

test('profile version rejects a different-tab profile write without a partial website/progress mutation', async () => {
  const f = fixture({ completed: [] });
  const payload = await f.profilePayload({ city: 'Dhaka' });
  f.state().owner.businessEmail = 'new@example.com';
  await assert.rejects(f.service.saveStep(f.userId, payload), { code: 'ONBOARDING_PROFILE_CONFLICT' });
  assert.equal(f.state().owner.city, 'London');
  assert.equal(f.state().website.draftRevisionNumber, 5);
  assert.deepEqual(f.state().owner.onboardingCompletedSteps, []);
});

test('same request concurrently and after a lost response creates one receipt and one milestone', async () => {
  const f = fixture({ completed: [] });
  const payload = await f.profilePayload({ city: 'Dhaka' });
  const results = await Promise.all([f.service.saveStep(f.userId, payload), f.service.saveStep(f.userId, payload)]);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal(f.state().revisions.length, 1);
  assert.deepEqual(f.state().owner.onboardingCompletedSteps, ['business_profile']);
  assert.equal((await f.service.saveStep(f.userId, payload)).replayed, true);
  assert.equal(f.state().revisions.length, 1);
});

test('a late retry acknowledges the latest state rather than undoing a subsequent deliberate save', async () => {
  const f = fixture();
  const old = await f.profilePayload({ city: 'Dhaka' });
  await f.service.saveStep(f.userId, old);
  await f.service.saveStep(f.userId, await f.profilePayload({ city: 'London' }));
  const retry = await f.service.saveStep(f.userId, old);
  assert.equal(retry.bootstrap.profile.city, 'London');
  assert.equal(retry.replayed, true);
  assert.equal(f.state().revisions.length, 2);
});

test('branding persists all fields and owned logo/favicon before progress and revision', async () => {
  const f = fixture({ completed: ['business_profile'] });
  const logo = 'https://cdn.example.com/logo.png', favicon = 'https://cdn.example.com/favicon.png';
  for (const [slot, url] of [['logo',logo],['favicon',favicon]]) f.assets.set(`${f.websiteId}:${url}`, { metadata: { provider: 'r2', kind: 'brand', slot, immutable: true } });
  const branding = { primaryColor: '#102030', secondaryColor: '#405060', accentColor: '#708090', font: 'Inter', logo, favicon };
  const result = await f.service.saveStep(f.userId, { schemaVersion: 2, websiteId: f.websiteId, step: 'branding', expectedRevisionNumber: 5, branding });
  for (const [key, value] of Object.entries(branding)) assert.equal(result.bootstrap.website[key], value);
  assert.deepEqual(result.bootstrap.onboarding.completedSteps, ['business_profile','branding']);
  assert.equal(result.draftRevisionNumber, 6);
  assert.equal(f.state().revisions[0].snapshot.favicon, favicon);
  const cleared = await f.service.saveStep(f.userId, { schemaVersion: 2, websiteId: f.websiteId, step: 'branding', expectedRevisionNumber: 6, branding: { logo: null, favicon: null, font: null } });
  assert.equal(cleared.bootstrap.website.favicon, null);
  assert.equal(cleared.bootstrap.website.logo, null);
  assert.equal(cleared.bootstrap.website.primaryColor, branding.primaryColor);
});

test('foreign, unregistered or wrong-slot assets fail before any branding milestone', async () => {
  for (const kind of ['foreign', 'unregistered', 'wrong-slot']) {
    const f = fixture({ completed: ['business_profile'] });
    const url = 'https://cdn.example.com/asset.png';
    if (kind === 'foreign') f.assets.set(`foreign-website:${url}`, { metadata: { provider: 'r2', kind: 'brand', slot: 'favicon', immutable: true } });
    if (kind === 'wrong-slot') f.assets.set(`${f.websiteId}:${url}`, { metadata: { provider: 'r2', kind: 'brand', slot: 'logo', immutable: true } });
    await assert.rejects(f.service.saveStep(f.userId, { schemaVersion: 2, websiteId: f.websiteId, step: 'branding', expectedRevisionNumber: 5, branding: { favicon: url, primaryColor: '#123456' } }), { code: 'WEBSITE_MANAGED_ASSET_REQUIRED' });
    assert.equal(f.state().website.primaryColor, '#000000');
    assert.deepEqual(f.state().owner.onboardingCompletedSteps, ['business_profile']);
    assert.equal(f.state().revisions.length, 0);
  }
});

test('complete catalog above the old 100-row UI limit is safe; explicit single deselection affects only that row', async () => {
  const f = fixture({ catalogSize: 205 });
  const context = await f.service.getServicesContext(f.userId);
  assert.equal(context.catalog.complete, true);
  assert.equal(context.catalog.services.length, 205);
  const change = servicePatch(f.rows()[0], { serviceName: 'Renamed cleaning', addOns: [{ name: 'Oven and fridge', price: 30 }] });
  const result = await f.service.saveStep(f.userId, await f.servicesPayload([change], [serviceId(2)]));
  assert.equal(result.catalog.services.length, 205);
  assert.equal(result.catalog.services.filter(r => r.status === 'ACTIVE').length, 204);
  assert.equal(f.rows()[0].id, serviceId(1));
  assert.equal(f.rows()[0].slug, 'service-1');
  assert.deepEqual(f.rows()[0].addOns, [{ name: 'Oven and fridge', price: 30 }]);
  assert.equal(f.rows()[204].status, 'ACTIVE');
  assert.deepEqual(f.rows()[204].addOns, [{ name: 'Oven', price: 15 }]);
});

test('legacy selected-page upsert no longer deactivates omitted services; omitted add-ons are preserved', async () => {
  const f = fixture({ catalogSize: 205 });
  await f.prisma.$transaction(tx => f.catalog.syncServiceCatalogSelectionTx(tx, f.adminId, [servicePatch(f.rows()[0], { basePrice: 91 })], { authoritativeSelection: true }));
  assert.equal(f.rows().filter(r => r.status === 'ACTIVE').length, 205);
  assert.deepEqual(f.rows()[0].addOns, [{ name: 'Oven', price: 15 }]);
  await f.prisma.$transaction(tx => f.catalog.syncServiceCatalogSelectionTx(tx, f.adminId, [servicePatch(f.rows()[0], { addOns: [] })]));
  assert.deepEqual(f.rows()[0].addOns, []);
});

test('concurrent service update, new row or ABA timestamp change conflicts without overwriting another tab', async () => {
  for (const action of ['update', 'create', 'timestamp']) {
    const f = fixture();
    const payload = await f.servicesPayload([servicePatch(f.rows()[0], { basePrice: 1 })]);
    if (action === 'update') f.rows()[0].basePrice = 500;
    if (action === 'create') await f.db.serviceCatalog.create({ data: { ...f.rows()[0], id: serviceId(2), slug: 'service-2', serviceName: 'Second tab' } });
    if (action === 'timestamp') f.rows()[0].updatedAt = new Date('2026-01-02');
    const before = copy(f.rows());
    await assert.rejects(f.service.saveStep(f.userId, payload), { code: 'ONBOARDING_CATALOG_CONFLICT' });
    assert.deepEqual(f.rows(), before);
    assert.equal(f.state().revisions.length, 0);
  }
});

test('booking/revision failure rolls back services, profile, progress and website together', async () => {
  const f = fixture();
  const payload = await f.servicesPayload([servicePatch(f.rows()[0], { addOns: [] })]);
  const original = copy(f.rows());
  f.controls.failBooking = true;
  await assert.rejects(f.service.saveStep(f.userId, payload), /booking configuration rejected/);
  assert.deepEqual(f.rows(), original);
  assert.deepEqual(f.state().owner.onboardingCompletedSteps, ['business_profile','branding']);
  f.controls.failBooking = false;
  f.controls.failRevision = true;
  await assert.rejects(f.service.saveStep(f.userId, payload), /revision write failed/);
  assert.deepEqual(f.rows(), original);
  assert.equal(f.state().website.draftRevisionNumber, 5);
});

test('unknown tenant IDs and v2 mutable-name identity substitution are rejected', async () => {
  const f = fixture();
  const payload = await f.servicesPayload([servicePatch(f.rows()[0], { serviceCatalogId: serviceId(999) })]);
  await assert.rejects(f.service.saveStep(f.userId, payload), { code: 'SERVICE_CATALOG_ID_INVALID' });
  const anonymous = servicePatch(f.rows()[0]); delete anonymous.serviceCatalogId;
  await assert.rejects(f.service.saveStep(f.userId, await f.servicesPayload([anonymous])), { code: 'SERVICE_NAME_CONFLICT' });
  await assert.rejects(f.service.saveStep(f.userId, { ...await f.profilePayload(), websiteId: 'foreign-website' }), { code: 'ONBOARDING_WEBSITE_CHANGED' });
});

test('expected revision zero is a real precondition, not an escape from optimistic concurrency', async () => {
  const f = fixture();
  await assert.rejects(f.service.saveStep(f.userId, { ...await f.profilePayload(), expectedRevisionNumber: 0 }), { code: 'WEBSITE_DRAFT_CONFLICT' });
  assert.equal(f.state().revisions.length, 0);
});

test('cache failure after commit does not lose persisted acknowledgement or duplicate a retry', async () => {
  const f = fixture(); f.controls.failCache = true;
  const payload = await f.profilePayload({ businessDescription: null });
  const saved = await f.service.saveStep(f.userId, payload);
  assert.equal(saved.bootstrap.profile.businessDescription, null);
  assert.equal((await f.service.saveStep(f.userId, payload)).replayed, true);
  assert.equal(f.state().revisions.length, 1);
});

test('lock acquisition order is website, owner row, booking, catalog; progress sets deduplicate legacy template', async () => {
  const f = fixture();
  await f.service.getServicesContext(f.userId);
  assert.ok(f.operations.indexOf(`website.lock:${f.websiteId}`) < f.operations.indexOf('owner.lock'));
  assert.ok(f.operations.indexOf('owner.lock') < f.operations.indexOf(`website-booking-provision:${f.adminId}`));
  assert.ok(f.operations.indexOf(`website-booking-provision:${f.adminId}`) < f.operations.indexOf(`service-catalog:${f.adminId}`));
  assert.deepEqual([...f.progress.normalizeCompletedSetupSteps(['template','review_launch','branding','branding','invalid'], null)], ['review_launch','branding']);
  assert.equal(f.progress.canonicalOnboardingStep('template'), 'review_launch');
});

test('legacy add-on prices normalize losslessly while invalid saved JSON fails closed', () => {
  const f = fixture();
  assert.deepEqual(f.concurrency.readOnboardingAddOns([{ name: 'Oven', priceGbp: 20 }]), [{ name: 'Oven', price: 20 }]);
  assert.deepEqual(f.concurrency.readOnboardingAddOns([{ name: 'Oven', price: 0, priceGbp: 20 }]), [{ name: 'Oven', price: 0 }]);
  assert.throws(() => f.concurrency.readOnboardingAddOns({ malformed: true }), { code: 'SERVICE_ADDONS_DATA_INVALID' });
  assert.throws(() => f.concurrency.readOnboardingAddOns([{ name: 'Oven', price: -1 }]), { code: 'SERVICE_ADDONS_DATA_INVALID' });
});
