const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const status = {BAD_REQUEST:400,FORBIDDEN:403,CONFLICT:409,UNPROCESSABLE_ENTITY:422};
const mocks = {'http-status':status};
const { TemplateRegistry } = loadTypeScript('src/modules/Website/templateRegistry.ts',mocks);
const { buildTemplateSelectionPatch } = loadTypeScript('src/modules/Website/templateSelection.ts',mocks);
const { readWebsiteTemplateRelease } = loadTypeScript('src/modules/Website/websiteTemplateRelease.ts');
function withRelease(enabled, defaultVersion, action) {
  const previous=[process.env.WEBSITE_TEMPLATE_V2_ENABLED,process.env.WEBSITE_DEFAULT_TEMPLATE_VERSION];
  process.env.WEBSITE_TEMPLATE_V2_ENABLED=String(enabled); process.env.WEBSITE_DEFAULT_TEMPLATE_VERSION=defaultVersion;
  try { return action(); } finally { ['WEBSITE_TEMPLATE_V2_ENABLED','WEBSITE_DEFAULT_TEMPLATE_VERSION'].forEach((name,i)=>previous[i]===undefined?delete process.env[name]:process.env[name]=previous[i]); }
}
test('release gate defaults to v1 and rejects invalid/incompatible activation',()=>{
  assert.deepEqual(readWebsiteTemplateRelease({}),{refreshedEnabled:false,defaultVersion:'1.0.0'});
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_TEMPLATE_V2_ENABLED:'yes'}));
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_DEFAULT_TEMPLATE_VERSION:'3.0.0'}));
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_DEFAULT_TEMPLATE_VERSION:'2.0.0'}));
});
test('all four explicit v1 and v2 renderers are registered; v1 remains selectable and immutable',()=>withRelease(false,'1.0.0',()=>{
  assert.equal(TemplateRegistry.list().length,8); assert.equal(TemplateRegistry.listSelectable().length,4);
  for(const id of ['clean-modern','premium-home','commercial-pro','local-cleaning']) {
    const original=TemplateRegistry.requireTemplate(id,'1.0.0');assert.equal(original.version,'1.0.0');
    assert.equal(TemplateRegistry.requireTemplate(id,'2.0.0').schemaVersion,1);
    original.capabilities.booking=false; assert.equal(TemplateRegistry.requireTemplate(id,'1.0.0').capabilities.booking,true);
    assert.throws(()=>TemplateRegistry.requirePublishable(id,'2.0.0'),{code:'WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE'});
  }
}));
test('activation enables explicit selection but changes the default only when separately configured',()=>withRelease(true,'1.0.0',()=>{
  assert.equal(TemplateRegistry.listSelectable().length,8);assert.equal(TemplateRegistry.defaultTemplate().version,'1.0.0');
  assert.equal(TemplateRegistry.requireSelectable('clean-modern','2.0.0').version,'2.0.0');
  withRelease(true,'2.0.0',()=>assert.equal(TemplateRegistry.defaultTemplate().version,'2.0.0'));
}));
test('versionless legacy writes cannot upgrade an existing website',()=>withRelease(true,'2.0.0',()=>{
  const current={templateId:'clean-modern',templateVersion:'1.0.0'};
  assert.deepEqual(buildTemplateSelectionPatch({},current),{});
  assert.equal(buildTemplateSelectionPatch({templateId:'clean-modern'},current).templateVersion,'1.0.0');
  assert.equal(buildTemplateSelectionPatch({templateId:'premium-home'},current).templateVersion,'1.0.0');
  assert.equal(buildTemplateSelectionPatch({templateVersion:'2.0.0'},current).templateVersion,'2.0.0');
  const upgraded={templateId:'clean-modern',templateVersion:'2.0.0'};
  assert.equal(buildTemplateSelectionPatch({templateId:'clean-modern'},upgraded).templateVersion,'2.0.0');
}));
test('gate rollback permits editing already selected v2, but blocks a new v2 publication',()=>withRelease(false,'1.0.0',()=>{
  const current={templateId:'clean-modern',templateVersion:'2.0.0'};
  assert.equal(buildTemplateSelectionPatch({templateId:'clean-modern'},current).templateVersion,'2.0.0');
  assert.throws(()=>TemplateRegistry.requirePublishable('clean-modern','2.0.0'),{code:'WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE'});
  assert.equal(TemplateRegistry.requireTemplate('clean-modern','2.0.0').version,'2.0.0');
}));
const goodDesign=()=>({schemaVersion:1,componentOverrides:{},componentAnimations:{},sectionStyles:{},animationsEnabled:false});
const {WebsiteComponentRegistry,assertWebsiteDesignPublishable}=loadTypeScript('src/modules/Website/websiteComponentRegistry.ts',{
  ...mocks, './websiteDesignContract':{parseWebsiteDesignContract:value=>value||goodDesign(),websiteDesignContractSchema:{safeParse:value=>({success:true,data:value})}},
});
test('component registry retains every old ID, adds versioned counterparts, and does not expose mutable entries',()=>{
  const registry=WebsiteComponentRegistry.list();assert.equal(registry.length,48);
  for(const item of registry.filter(item=>item.id.endsWith('.v1'))) {
    const next=WebsiteComponentRegistry.find(item.id.replace(/\.v1$/,'.v2'));assert.equal(next.slot,item.slot);assert.equal(next.entitlement,item.entitlement);
  }
  registry[0].slot='not-a-slot';assert.notEqual(WebsiteComponentRegistry.list()[0].slot,'not-a-slot');
});
test('v2 components enforce release, slot ownership, known IDs and premium entitlement at publication',()=>{
  const design=goodDesign(); design.componentOverrides={shared:{header:'shared.header.modern-glass.v2'}};
  withRelease(false,'1.0.0',()=>assert.throws(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:true}),{code:'WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE'}));
  withRelease(true,'1.0.0',()=>{
    assert.throws(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:false}),{code:'WEBSITE_PREMIUM_COMPONENT_REQUIRED'});
    assert.doesNotThrow(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:true}));
    design.componentOverrides={home:{hero:'shared.header.minimal.v2'}};
    assert.throws(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:true}),{code:'WEBSITE_COMPONENT_SLOT_MISMATCH'});
    design.componentOverrides={home:{hero:'made-up.v2'}};
    assert.throws(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:true}),{code:'WEBSITE_COMPONENT_UNKNOWN'});
    design.componentOverrides={}; design.sectionStyles={'unregistered.section':{backgroundColor:'#ffffff'}};
    assert.throws(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:true}),{code:'WEBSITE_DESIGN_SLOT_INVALID'});
  });
});
const {assertOwnedHeroImages,contentImageUrls}=loadTypeScript('src/modules/Website/websiteContentAssets.ts',mocks);
test('hero-image ownership is scoped to the current website and deduplicates repeated URLs',async()=>{
  const calls=[];const db={websiteAsset:{findFirst:async query=>{calls.push(query);return {mimeType:'image/webp'};}}};
  await assertOwnedHeroImages(db,'website-a',[{kind:'HOME',content:{heroImageUrl:'https://assets.invalid/a.webp'}},{kind:'HOME',content:{heroImageUrl:'https://assets.invalid/a.webp'}}]);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].where,{websiteId:'website-a',url:'https://assets.invalid/a.webp'});
  for(const asset of [null,{mimeType:'text/html'},{mimeType:null}]) await assert.rejects(()=>assertOwnedHeroImages({websiteAsset:{findFirst:async()=>asset}},'website-b',[{kind:'HOME',content:{heroImageUrl:'https://assets.invalid/a.webp'}}]),{code:'WEBSITE_CONTENT_ASSET_INVALID'});
});
test('clearing media is accepted; historical ABOUT URLs retain their contract; all content references are tracked',async()=>{
  await assertOwnedHeroImages({websiteAsset:{findFirst:()=>{throw Error('must not read');}}},'website-a',[{kind:'HOME',content:{heroImageUrl:null}},{kind:'ABOUT',content:{imageUrl:'https://legacy.invalid/photo'}}]);
  assert.deepEqual(contentImageUrls([{kind:'HOME',content:{heroImageUrl:' https://assets.invalid/a '}},{kind:'ABOUT',content:{imageUrl:'https://assets.invalid/a'}},{kind:'SERVICES',content:{heroImageUrl:'https://ignore.invalid/'}}]),['https://assets.invalid/a']);
});

const {resolveCompatibleBackendTemplate,resolveTemplateDowngradeFallback}=loadTypeScript('src/modules/Website/websiteTemplateCompatibility.ts',mocks);
test('public compatibility and entitlement downgrade cannot upgrade an old publication to the latest release',()=>{
  for(const id of ['clean-modern','premium-home','commercial-pro','local-cleaning']) {
    for(const version of ['1.0.0','2.0.0']) {
      const identity={templateId:id,templateVersion:version,schemaVersion:1};
      const exact=resolveCompatibleBackendTemplate(identity);
      assert.equal(exact.id,id);assert.equal(exact.version,version);
      assert.equal(resolveTemplateDowngradeFallback(identity,exact).version,version);
    }
    assert.equal(resolveCompatibleBackendTemplate({templateId:id,templateVersion:'99.0.0',schemaVersion:1}).version,'1.0.0');
    assert.equal(resolveCompatibleBackendTemplate({templateId:id,templateVersion:'1.0.0',schemaVersion:99}),null);
  }
  assert.equal(resolveCompatibleBackendTemplate({templateId:'unknown',templateVersion:'99.0.0',schemaVersion:1}).key,'clean-modern@1.0.0');
});
