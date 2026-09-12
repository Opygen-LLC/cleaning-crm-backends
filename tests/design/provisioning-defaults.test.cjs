const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');

const root = path.resolve(__dirname, '../..');
const { buildInitialWebsitePages } = loadTypeScript(
  path.join(root, 'src/modules/Website/websiteProvisioningDefaults.ts'),
);

test('new websites provision all seven routes with booking on by default and estimate fail-closed', () => {
  let nextId = 0;
  const timestamp = new Date('2026-09-07T00:00:00.000Z');
  const rows = buildInitialWebsitePages('website-1', timestamp, () => `page-${++nextId}`);

  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((page) => page.slug), ['/', '/services', '/about', '/reviews', '/contact', '/book', '/estimate']);
  assert.equal(new Set(rows.map((page) => page.id)).size, rows.length);
  assert.ok(rows.every((page) => page.websiteId === 'website-1'));
  assert.ok(rows.every((page) => page.createdAt === timestamp && page.updatedAt === timestamp));

  for (const page of rows.filter((page) => !['BOOK', 'ESTIMATE'].includes(page.kind))) {
    assert.equal(page.isEnabled, true, `${page.kind} should be enabled`);
  }
  assert.equal(rows.find((page) => page.kind === 'BOOK').isEnabled, true);
  assert.equal(rows.find((page) => page.kind === 'BOOK').showInNavigation, true);
  assert.equal(rows.find((page) => page.kind === 'ESTIMATE').isEnabled, false);
});

test('page content is cloned for every provisioning run', () => {
  const a = buildInitialWebsitePages('website-a', new Date(), () => 'a');
  const b = buildInitialWebsitePages('website-b', new Date(), () => 'b');
  const homeA = a.find((page) => page.kind === 'HOME');
  const homeB = b.find((page) => page.kind === 'HOME');
  homeA.content.heroTitle = 'Changed only in A';
  assert.notEqual(homeB.content.heroTitle, homeA.content.heroTitle);
});
