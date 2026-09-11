const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("subscription/me exposes server-authoritative lifecycle, access and usage", () => {
  const service = read("src/modules/Subscription/subscription.service.ts");
  const start = service.indexOf("const getMySubscription");
  const end = service.indexOf("// ─── Existing: create trial subscription");
  const block = service.slice(start, end);

  assert.match(block, /TenantAccessResolver\.resolve\(adminId\)/);
  assert.match(block, /serverTime: now\.toISOString\(\)/);
  assert.match(block, /lifecycle:\s*\{/);
  assert.match(block, /daysRemaining:/);
  assert.match(block, /secondsRemaining:/);
  assert.match(block, /dashboardAllowed: access\.access\.dashboardAllowed/);
  assert.match(block, /recoveryAllowed: access\.access\.recoveryAllowed/);
  assert.match(block, /effectiveEntitlements: access\.effectiveEntitlements/);
  assert.match(block, /getSubscriptionUsageSnapshot/);
});

test("recovery usage matches the same staff/client/month booking semantics as backend limits", () => {
  const service = read("src/modules/Subscription/subscription.service.ts");
  const start = service.indexOf("const getSubscriptionUsageSnapshot");
  const end = service.indexOf("const getLifecycleState");
  const block = service.slice(start, end);

  assert.match(block, /startOfMonth\(now\)/);
  assert.match(block, /FROM "StaffProfile" sp[\s\S]*sp\."adminId"/);
  assert.match(block, /FROM "client" c[\s\S]*c\."adminId"/);
  assert.match(block, /FROM "booking" b[\s\S]*b\."createdAt" >= \$\{monthStart\}/);
  assert.doesNotMatch(block, /sp\."status"/);
  assert.doesNotMatch(block, /c\."status"/);

  const percentageStart = service.indexOf("const percentage");
  const percentageEnd = service.indexOf("const getSubscriptionUsageSnapshot");
  const percentageBlock = service.slice(percentageStart, percentageEnd);
  assert.match(percentageBlock, /if \(limit === null\) return null/);
  assert.match(percentageBlock, /if \(limit <= 0\) return 100/);
});

test("automatic trial provisioning cannot be repeated for an existing tenant", () => {
  const service = read("src/modules/Subscription/subscription.service.ts");
  const start = service.indexOf("const createTrialSubscription");
  const end = service.indexOf("// ─── Phase 6: pending plan-change checkout");
  const block = service.slice(start, end);

  assert.match(block, /subscription-trial-provision:\$\{adminId\}/);
  assert.match(block, /where: \{ adminId \}/);
  assert.match(block, /TRIAL_ALREADY_PROVISIONED/);
  assert.match(block, /skipExistingCheck/);
  assert.match(block, /status: SubscriptionStatus\.ACTIVE/);
  assert.match(block, /isTrial: true/);
});

test("expired accounts have a narrowly scoped R2 payment-proof recovery path", () => {
  const routes = read("src/modules/Subscription/subscription.routes.ts");
  const validation = read("src/modules/Subscription/subscription.validation.ts");
  const service = read("src/modules/Subscription/subscription.service.ts");

  assert.match(routes, /"\/me\/proof-upload\/initiate"/);
  assert.match(routes, /"\/me\/proof-upload\/:uploadId\/complete"/);
  assert.match(routes, /checkAuth\(UserRole\.ADMIN\)/);
  assert.match(validation, /proofUploadInitiateSchema/);
  assert.match(validation, /max\(100 \* 1024 \* 1024\)/);
  assert.match(validation, /proofUploadParamsSchema/);
  assert.match(validation, /z\.string\(\)\.uuid/);

  const start = service.indexOf("const initiateSubscriptionProofUpload");
  const end = service.indexOf("const submitPaymentProof");
  const block = service.slice(start, end);
  assert.match(block, /assertSelfServiceRecoveryAllowed\(adminId\)/);
  assert.match(block, /purpose: "SUBSCRIPTION_PROOF"/);
  assert.match(block, /mediaService\.initiateUpload/);
  assert.match(block, /mediaService\.finalizeUpload/);
});

test("plan checkout and proof submission are concurrency-safe and duplicate-aware", () => {
  const service = read("src/modules/Subscription/subscription.service.ts");
  const changeStart = service.indexOf("const changePlan");
  const cancelStart = service.indexOf("const cancelPendingPlanChange");
  const changeBlock = service.slice(changeStart, cancelStart);

  assert.match(changeBlock, /subscription-checkout:\$\{current\.id\}/);
  assert.match(changeBlock, /acquireExtendedTextTransactionAdvisoryLock\(tx, lockKey\)/);
  assert.match(changeBlock, /freshSubscription\?\.status === SubscriptionStatus\.PENDING_PAYMENT/);
  assert.match(changeBlock, /planChangeId: null/);
  assert.match(changeBlock, /PAYMENT_PROOF_ALREADY_PENDING/);

  const proofStart = service.indexOf("const submitPaymentProof");
  const proofEnd = service.indexOf("export const subscriptionService");
  const proofBlock = service.slice(proofStart, proofEnd);
  assert.match(proofBlock, /subscription-checkout:\$\{sub\.id\}/);
  assert.match(proofBlock, /PAYMENT_PROOF_ALREADY_PENDING/);
  assert.match(proofBlock, /paymentProofMediaAssetId: proofAsset\.id/);
  assert.match(proofBlock, /currency: sub\.subscriptionPlan\.currency/);
});

test("legacy payment approval is idempotent and converts trial state to paid", () => {
  const superAdmin = read("src/modules/SuperAdmin/superAdmin.service.ts");
  assert.match(superAdmin, /subscription-checkout:\$\{sub\.id\}/);
  assert.match(superAdmin, /PAYMENT_PROOF_ALREADY_REVIEWED/);
  assert.match(superAdmin, /status:\s*SubscriptionStatus\.ACTIVE/);
  assert.match(superAdmin, /isTrial:\s*false/);
  assert.match(superAdmin, /trialEndsAt:\s*null/);
});

test("expired subscription recovery keeps profile access narrow and does not delete business data", () => {
  const middleware = read("src/middlewares/checkSubscription.ts");
  const adminRoutes = read("src/modules/Admin/admin.routes.ts");
  const routes = read("src/routes/index.ts");
  const expiryCron = read("src/cron/subscriptionExpiry.cron.ts");

  assert.match(middleware, /checkSubscriptionRecoveryAccess/);
  assert.match(middleware, /resolution\.access\.recoveryAllowed/);
  assert.match(adminRoutes, /recoveryRouter\.get\([\s\S]*?"\/profile"[\s\S]*?checkSubscriptionRecoveryAccess/);
  assert.match(adminRoutes, /recoveryRouter\.patch\([\s\S]*?"\/profile"[\s\S]*?checkSubscriptionRecoveryAccess/);
  assert.ok(
    routes.indexOf("route: adminRecoveryRoutes") < routes.indexOf("route: adminRoutes"),
    "recovery-safe profile router must mount before the normal subscription-gated admin router",
  );
  assert.match(expiryCron, /subscription\.updateMany/);
  assert.doesNotMatch(expiryCron, /client\.delete|booking\.delete|staffProfile\.delete|invoice\.delete/);
});
