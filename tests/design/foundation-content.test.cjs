const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const { DEFAULT_WEBSITE_PAGES } = loadTypeScript('src/modules/Website/website.constant.ts');

test('newly provisioned page defaults contain no unsupported business claims',()=>{
  assert.deepEqual(DEFAULT_WEBSITE_PAGES.map(page=>page.kind),['HOME','SERVICES','ABOUT','REVIEWS','CONTACT','BOOK','ESTIMATE']);
  const home=DEFAULT_WEBSITE_PAGES.find(page=>page.kind==='HOME').content;
  const about=DEFAULT_WEBSITE_PAGES.find(page=>page.kind==='ABOUT').content;
  assert.deepEqual(home.whyItems,[]);
  assert.equal(home.howItWorksHeading,'A straightforward place to start');
  assert.equal(home.howItWorksIntro,'');
  assert.deepEqual(home.howItWorksSteps.map(step=>step.title),[
    'Explore services','Choose how to get in touch','Review your details',
  ]);
  assert.ok(home.howItWorksSteps.every(step=>step.description && typeof step.description==='string'));
  assert.deepEqual(about.values,[]);
  assert.equal(about.imageUrl,null);assert.equal(about.imageAlt,'');assert.equal(about.yearsExperience,null);
  assert.equal(home.footerDescription,'');assert.equal(home.footerTrustText,'');
  const copy=JSON.stringify(DEFAULT_WEBSITE_PAGES);
  assert.doesNotMatch(copy,/fully insured|guarantee|years? of experience|5,?000|trusted by|dependable|reliable|professional cleaning team|eco[- ]friendly|certified|24\/7|same[- ]day/i);
});
