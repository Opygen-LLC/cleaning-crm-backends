const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('follow-up version and timezone cache helpers use the canonical Redis keys', async () => {
  const calls = [];
  const redis = {
    incr: async (key) => calls.push(['incr', key]),
    del: async (key) => calls.push(['del', key]),
  };
  const mod = loadTypeScript(path.join(root, 'src/modules/Lead/followUpCache.ts'), {
    '../../config/redis': { __esModule: true, default: redis },
  });
  await mod.invalidateFollowUpsCache('admin-1');
  await mod.invalidateAdminTimezoneCache('admin-1');
  assert.deepEqual(calls, [
    ['incr', 'followups:ver:admin-1'],
    ['del', 'admin:tz:admin-1'],
  ]);
});

test('today boundaries are calculated in business timezone including DST days', () => {
  const time = loadTypeScript(path.join(root, 'src/modules/Lead/followUpTime.ts'));
  assert.equal(time.dateKeyInZone(new Date('2026-09-11T18:30:00.000Z'), 'Asia/Dhaka'), '2026-09-12');
  assert.equal(time.localMidnightToUtc('2026-09-12', 'Asia/Dhaka').toISOString(), '2026-09-11T18:00:00.000Z');

  // New York spring-forward day is 23 hours long. Midnight conversion must not
  // use a fixed offset from another day.
  const nyStart = time.localMidnightToUtc('2026-03-08', 'America/New_York');
  const nyNext = time.localMidnightToUtc('2026-03-09', 'America/New_York');
  assert.equal((nyNext - nyStart) / 3600000, 23);
});

test('initial follow-up and every activity write share one version invalidator', () => {
  const lead = read('src/modules/Lead/lead.service.ts');
  const activity = read('src/modules/Lead/leadActivity.service.ts');
  assert.match(lead, /if \(payload\.initialFollowUp\)[\s\S]*invalidateFollowUpsCache\(adminProfile\.id\)/);
  assert.ok((activity.match(/invalidateFollowUpsCache\(adminId\)/g) || []).length >= 3);
  assert.match(activity, /redis\.get\(followUpVersionKey\(adminId\)\)/);
});

test('timezone changes and service areas are protected server-side', () => {
  const admin = read('src/modules/Admin/admin.service.ts');
  const onboarding = read('src/modules/Admin/onboardingSave.service.ts');
  assert.match(admin, /WORK_LOCATION_COUNTRY_MISMATCH/);
  assert.match(admin, /scalarFields\.businessHours !== undefined[\s\S]*invalidateAdminTimezoneCache/);
  assert.match(onboarding, /payload\.profile\.businessHours !== undefined[\s\S]*invalidateAdminTimezoneCache/);
});
