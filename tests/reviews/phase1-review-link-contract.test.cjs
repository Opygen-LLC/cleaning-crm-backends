const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("admin review-link routes remain authenticated and feature-gated", () => {
  const routes = read("src/modules/Review/review.routes.ts");
  const linkOptions = routes.match(/router\.get\([\s\S]*?"\/link-options"[\s\S]*?\);/);
  const shareLink = routes.match(/router\.post\([\s\S]*?"\/share-link"[\s\S]*?\);/);
  assert.ok(linkOptions, "GET /review/link-options must exist");
  assert.ok(shareLink, "POST /review/share-link must exist");
  for (const route of [linkOptions[0], shareLink[0]]) {
    assert.match(route, /isTenantAdmin/);
    assert.match(route, /hasReviews/);
    assert.match(route, /zodValidate/);
  }
  assert.ok(
    routes.indexOf('"/link-options"') < routes.indexOf('"/:id"'),
    "specific review-link routes must be registered before /:id",
  );
});

test("share-link input is a strict discriminated union", () => {
  const validation = read("src/modules/Review/review.validation.ts");
  assert.match(validation, /z\.discriminatedUnion\("kind"/);
  assert.match(validation, /kind: z\.literal\("COMPANY"\)/);
  assert.match(validation, /kind: z\.literal\("SERVICE"\)/);
  assert.match(validation, /serviceCatalogId: z\.string\(\)\.uuid\(\)/);
  assert.match(validation, /kind: z\.literal\("JOB"\)/);
  assert.match(validation, /jobId: z\.string\(\)\.uuid\(\)/);
});

test("canonical website links are server-resolved and tenant-bound", () => {
  const service = read("src/modules/Review/review.service.ts");
  assert.match(service, /TenantPublicUrlService\.resolveForAdminId\(adminId\)/);
  assert.match(service, /TenantAccessResolver\.resolve\(adminId, \{ authoritative: true \}\)/);
  assert.match(service, /where: \{ id: payload\.serviceCatalogId, adminId, status: "ACTIVE" \}/);
  assert.match(service, /where: \{ id: payload\.jobId, adminId \}/);
  assert.match(service, /job\.status !== "COMPLETED"/);
  assert.doesNotMatch(
    service.slice(service.indexOf("const createReviewShareLink"), service.indexOf("const getAllReviews")),
    /window\.|req\.headers\.host|origin header/i,
  );
});

test("completed-job token generation is concurrency-safe and rotates expired tokens", () => {
  const service = read("src/modules/Review/review.service.ts");
  const generateStart = service.indexOf("const generateReviewToken");
  const validateStart = service.indexOf("const validateReviewToken");
  const block = service.slice(generateStart, validateStart);
  assert.match(block, /prisma\.\$transaction/);
  assert.match(block, /review-token-job:\$\{jobId\}/);
  assert.match(block, /review-token:\$\{existing\.token\}/);
  assert.match(block, /if \(existing\.used\)/);
  assert.match(block, /REVIEW_ALREADY_SUBMITTED/);
  assert.match(block, /token: randomUUID\(\)/);
  assert.match(block, /expiresAt: nextReviewTokenExpiry\(\)/);
});

test("review-link discovery and creation responses are no-store", () => {
  const controller = read("src/modules/Review/review.controller.ts");
  const start = controller.indexOf("const getReviewLinkOptions");
  const end = controller.indexOf("const getAllReviews");
  const block = controller.slice(start, end);
  assert.equal((block.match(/Cache-Control/g) || []).length, 2);
  assert.equal((block.match(/no-store/g) || []).length, 2);
});
