const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/launch-fixture.cjs');

test('compact status uses durable latest proof without reading the public snapshot/history/analytics', async () => {
  const f = fixture(); const launch = await f.launch({ expectedRevisionNumber: 5 });
  assert.equal(launch.publicationDelivery.ready, true);
  const find = f.prisma.businessWebsite.findUnique;
  const reads = [];
  f.prisma.businessWebsite.findUnique = async args => {
    reads.push(args); assert.notEqual(args.select?.publishedSnapshot, true);
    assert.equal(args.include?.revisions, undefined); return find(args);
  };
  f.publicWebsite.getPublicWebsiteById = async () => assert.fail('status loaded a full public projection');
  f.prisma.websiteRevision.findMany = async () => assert.fail('status loaded history');
  const value = await f.delivery.getStatus(f.adminId);
  assert.equal(value.ready, true); assert.equal(value.websiteId, f.websiteId);
  assert.equal(value.publishedRevisionNumber, launch.website.publishedRevisionNumber);
  assert.ok(reads.length > 0); assert.equal(value.publishedSnapshot, undefined);
});
test('URL and published status without a delivery receipt are preparing, never ready', async () => {
  const f = fixture(); await f.launch({ expectedRevisionNumber: 5 });
  f.state().website.publicationDeliveryReceipt = null;
  const value = await f.delivery.getStatus(f.adminId);
  assert.equal(value.ready, false); assert.equal(value.state, 'preparing');
});
test('an old lifecycle receipt cannot acknowledge a newer event pointer', async () => {
  const f = fixture(); const launch = await f.launch({ expectedRevisionNumber: 5 });
  const event = Array.from(f.state().events.values())[0];
  f.state().website.publicationDeliveryEventId = 'restoration-in-flight';
  f.state().website.publicationDeliveryReceipt = { ready: false, state: 'preparing' };
  const update = await f.delivery.recordReceipt(event.id, f.websiteId, launch.publicationDelivery);
  assert.equal(update.count, 0); assert.equal(f.state().website.publicationDeliveryReceipt.ready, false);
});
test('receipt persistence failure rolls back event completion and leaves the durable retry recoverable', async () => {
  const f = fixture(); await f.launch({ expectedRevisionNumber: 5 });
  const event = Array.from(f.state().events.values())[0]; event.status = 'PENDING';
  const update = f.db.businessWebsite.updateMany;
  f.db.businessWebsite.updateMany = async args => { if (args.data.publicationDeliveryReceipt?.delivered) throw Error('receipt-storage-failure'); return update(args); };
  const result = await f.delivery.attemptImmediate(event);
  assert.equal(result.revalidationQueued, true);
  assert.equal(Array.from(f.state().events.values())[0].status, 'PENDING');
});
