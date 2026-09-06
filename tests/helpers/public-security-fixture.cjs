const path = require('node:path');
const { fixture } = require('./launch-fixture.cjs');
const { loadTypeScript } = require('./load-typescript.cjs');

// Real publicWebsite.service + resolver + Redis cache. The smaller launch
// fixture intentionally stubs the projection; security tests must not use that
// stub when asserting the public read authorization boundary.
exports.publicSecurityFixture = () => {
  const f = fixture();
  const prisma = {
    ...f.prisma,
    businessWebsite: { ...f.db.businessWebsite, findUnique: async args => {
      const value = await f.db.businessWebsite.findUnique(args);
      if (!value) return null;
      return { ...value, admin: { ...f.state().owner, serviceCatalogs: [], reviews: [], workLocations: [], bookingForms: [], estimateForms: [] } };
    } },
    review: { aggregate: async () => ({ _avg: { rating: null }, _count: { _all: 0 } }) },
  };
  class AppError extends Error { constructor(statusCode,message,details) { super(message); Object.assign(this,{statusCode},details); } }
  const mocks = {
    'http-status': { NOT_FOUND:404, SERVICE_UNAVAILABLE:503, UNPROCESSABLE_ENTITY:422 },
    '../../errorHelper/AppError': AppError,
    '../../lib/logger': { warn() {} },
    '../../lib/prisma/prisma': { prisma },
    '../../lib/utils/canonicalProjection': { projectCanonicalService:v=>v, projectPublicBusiness:v=>({name:v.businessName,currency:v.currency||'USD'}) },
    '../../lib/utils/resolveAdminId': { getAdminId:async()=>f.adminId },
    './websiteHostResolver.service': { WebsiteHostResolverService:f.host },
    './websiteProjectionCache.service': { WebsiteProjectionCacheService:f.projection },
    '../Entitlement/tenantAccessResolver.service': { TenantAccessResolver:f.access },
    './websiteTemplateCompatibility': { resolveCompatibleBackendTemplate:v=>({id:v.templateId,version:v.templateVersion,tier:'FREE'}),resolveTemplateDowngradeFallback:()=>null },
    './websiteSnapshot': { parsePublishedSnapshot:v=>v,buildPublishedSnapshot:v=>({version:1,website:v,pages:v.pages}),parseRevisionSnapshotAsPublished:v=>v },
    './websiteDomainReadiness': { readyWebsiteDomainWhere:{} },
    './websiteSeo': { buildDefaultWebsiteSeo:v=>({title:v.businessName,description:''}) },
    './websiteCanonicalHost': { getCanonicalWebsiteOrigin:s=>`https://${s}.sites.example.com` },
    './websiteEntitlement.service': { websiteEntitlementSubscriptionSelect:{},WebsiteEntitlementService:{fromAccess:()=>({advancedSeo:true,premiumTemplates:true,customDomains:false,customDomainLimit:0})} },
    '../../generated/prisma/enums': { ServiceStatus:{ACTIVE:'ACTIVE'} },
    '../Admin/onboardingProfile': { onboardingProfile:()=>({businessHours:null}),onboardingProfileVersion:()=> 'test-version' },
    './websitePreviewContract': { WEBSITE_PREVIEW_CONTRACT_VERSION:1 },
  };
  const {PublicWebsiteService}=loadTypeScript(path.join(__dirname,'../../src/modules/Website/publicWebsite.service.ts'),mocks);
  return {...f,publicWebsite:PublicWebsiteService};
};
