const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');

const root = path.resolve(__dirname, '../..');
const { publicIntegrationHeadline } = loadTypeScript(
  path.join(root, 'src/modules/Website/websitePublicIntegration.ts'),
);

test('published booking and estimate projections always provide a non-empty headline', () => {
  assert.equal(publicIntegrationHeadline('booking', null), 'Online booking');
  assert.equal(publicIntegrationHeadline('booking', '  '), 'Online booking');
  assert.equal(publicIntegrationHeadline('estimate', undefined), 'Request an estimate');
  assert.equal(publicIntegrationHeadline('estimate', '  Custom quote request  '), 'Custom quote request');
});
