const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('../helpers/load-typescript.cjs');
const status = {BAD_REQUEST:400,FORBIDDEN:403,CONFLICT:409,UNPROCESSABLE_ENTITY:422};
const mocks = {'http-status':status};
const { TemplateRegistry } = loadTypeScript('src/modules/Website/templateRegistry.ts',mocks);
const { buildTemplateSelectionPatch } = loadTypeScript('src/modules/Website/templateSelection.ts',mocks);
const { readWebsiteTemplateRelease } = loadTypeScript('src/modules/Website/websiteTemplateRelease.ts');
function withRelease(v2, v3, defaultVersion, action) {
  const names=['WEBSITE_TEMPLATE_V2_ENABLED','WEBSITE_TEMPLATE_V3_ENABLED','WEBSITE_DEFAULT_TEMPLATE_VERSION'];
  const previous=names.map(name=>process.env[name]);
  process.env.WEBSITE_TEMPLATE_V2_ENABLED=String(v2);
  process.env.WEBSITE_TEMPLATE_V3_ENABLED=String(v3);
  process.env.WEBSITE_DEFAULT_TEMPLATE_VERSION=defaultVersion;
  try { return action(); } finally { names.forEach((name,i)=>previous[i]===undefined?delete process.env[name]:process.env[name]=previous[i]); }
}
test('release configuration defaults to v3 and rejects invalid or gated defaults',()=>{
  assert.deepEqual(readWebsiteTemplateRelease({}),{refreshedEnabled:true,foundationEnabled:true,defaultVersion:'3.0.0'});
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_TEMPLATE_V2_ENABLED:'yes'}));
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_TEMPLATE_V3_ENABLED:'yes'}));
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_DEFAULT_TEMPLATE_VERSION:'4.0.0'}));
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_TEMPLATE_V2_ENABLED:'false',WEBSITE_DEFAULT_TEMPLATE_VERSION:'2.0.0'}));
  assert.throws(()=>readWebsiteTemplateRelease({WEBSITE_TEMPLATE_V3_ENABLED:'false',WEBSITE_DEFAULT_TEMPLATE_VERSION:'3.0.0'}));
});
test('all four immutable v1, v2 and v3 renderer contracts are registered',()=>withRelease(false,false,'1.0.0',()=>{
  assert.equal(TemplateRegistry.list().length,12); assert.equal(TemplateRegistry.listSelectable().length,4);
  for(const id of ['clean-modern','premium-home','commercial-pro','local-cleaning']) {
    for(const version of ['1.0.0','2.0.0','3.0.0']) assert.equal(TemplateRegistry.requireTemplate(id,version).schemaVersion,1);
    const original=TemplateRegistry.requireTemplate(id,'1.0.0');
    original.capabilities.booking=false; assert.equal(TemplateRegistry.requireTemplate(id,'1.0.0').capabilities.booking,true);
    assert.throws(()=>TemplateRegistry.requirePublishable(id,'2.0.0'),{code:'WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE'});
    assert.throws(()=>TemplateRegistry.requirePublishable(id,'3.0.0'),{code:'WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE'});
  }
}));
test('v2 and v3 gates are independent and the default is configured separately',()=>{
  withRelease(true,false,'1.0.0',()=>{assert.equal(TemplateRegistry.listSelectable().length,8);assert.equal(TemplateRegistry.requireSelectable('clean-modern','2.0.0').version,'2.0.0');});
  withRelease(false,true,'1.0.0',()=>{assert.equal(TemplateRegistry.listSelectable().length,8);assert.equal(TemplateRegistry.requireSelectable('clean-modern','3.0.0').version,'3.0.0');});
  withRelease(true,true,'1.0.0',()=>assert.equal(TemplateRegistry.defaultTemplate().version,'1.0.0'));
  withRelease(true,true,'3.0.0',()=>assert.equal(TemplateRegistry.defaultTemplate().version,'3.0.0'));
});
test('versionless existing writes cannot silently upgrade a tenant to v3',()=>withRelease(true,true,'3.0.0',()=>{
  const current={templateId:'clean-modern',templateVersion:'1.0.0'};
  assert.deepEqual(buildTemplateSelectionPatch({},current),{});
  assert.equal(buildTemplateSelectionPatch({templateId:'clean-modern'},current).templateVersion,'1.0.0');
  assert.equal(buildTemplateSelectionPatch({templateId:'premium-home'},current).templateVersion,'1.0.0');
  assert.equal(buildTemplateSelectionPatch({templateVersion:'3.0.0'},current).templateVersion,'3.0.0');
  const upgraded={templateId:'clean-modern',templateVersion:'3.0.0'};
  assert.equal(buildTemplateSelectionPatch({templateId:'clean-modern'},upgraded).templateVersion,'3.0.0');
}));
test('gate rollback permits editing an unchanged stored release while blocking a new publication',()=>withRelease(false,false,'1.0.0',()=>{
  for(const version of ['2.0.0','3.0.0']) {
    const current={templateId:'clean-modern',templateVersion:version};
    assert.equal(buildTemplateSelectionPatch({templateId:'clean-modern'},current).templateVersion,version);
    assert.throws(()=>TemplateRegistry.requirePublishable('clean-modern',version),{code:'WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE'});
    assert.equal(TemplateRegistry.requireTemplate('clean-modern',version).version,version);
  }
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
test('v2 component contract is publishable when either modern runtime is enabled',()=>{
  const design=goodDesign(); design.componentOverrides={shared:{header:'shared.header.modern-glass.v2'}};
  withRelease(false,false,'1.0.0',()=>assert.throws(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:true}),{code:'WEBSITE_TEMPLATE_RELEASE_UNAVAILABLE'}));
  for(const gates of [[true,false],[false,true],[true,true]]) withRelease(gates[0],gates[1],'1.0.0',()=>{
    assert.throws(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:false}),{code:'WEBSITE_PREMIUM_COMPONENT_REQUIRED'});
    assert.doesNotThrow(()=>assertWebsiteDesignPublishable(design,{premiumTemplates:true}));
  });
  withRelease(true,true,'3.0.0',()=>{
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
test('public compatibility and entitlement downgrade never upgrade an old publication',()=>{
  for(const id of ['clean-modern','premium-home','commercial-pro','local-cleaning']) {
    for(const version of ['1.0.0','2.0.0','3.0.0']) {
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
