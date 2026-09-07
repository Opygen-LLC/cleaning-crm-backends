import test from "node:test";
import assert from "node:assert/strict";
import {
  WEBSITE_FOUNDATION_TEMPLATE_KEYS,
  gitShaMatches,
  normalizeFrontendOrigin,
  validateFrontendWebsiteRuntime,
  verifyFrontendWebsiteRuntime,
} from "../../scripts/release/verifyWebsiteV3Frontend.mjs";

const validPayload = () => ({
  version: "1.2.3",
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  buildDate: "2026-09-07T00:00:00.000Z",
  websiteRuntime: {
    contractVersion: 1,
    projectionSchemaVersion: 1,
    foundationVersion: "3.0.0",
    foundationTemplateKeys: [...WEBSITE_FOUNDATION_TEMPLATE_KEYS],
    templateKeys: [
      "clean-modern@1.0.0", "clean-modern@2.0.0", "clean-modern@3.0.0",
      "premium-home@1.0.0", "premium-home@2.0.0", "premium-home@3.0.0",
      "commercial-pro@1.0.0", "commercial-pro@2.0.0", "commercial-pro@3.0.0",
      "local-cleaning@1.0.0", "local-cleaning@2.0.0", "local-cleaning@3.0.0",
    ],
  },
});

test("accepts a frontend only when all four v3 renderers and schema contract are deployed", () => {
  const result = validateFrontendWebsiteRuntime(validPayload(), { expectedSha: "0123456" });
  assert.equal(result.foundationVersion, "3.0.0");
  assert.deepEqual(result.templateKeys, WEBSITE_FOUNDATION_TEMPLATE_KEYS);
});

test("fails closed for a missing family, incompatible schema, or stale foundation", () => {
  const missing = validPayload();
  missing.websiteRuntime.templateKeys = missing.websiteRuntime.templateKeys.filter((key) => key !== "local-cleaning@3.0.0");
  assert.throws(() => validateFrontendWebsiteRuntime(missing), /missing required v3 website renderers/i);

  const schema = validPayload();
  schema.websiteRuntime.projectionSchemaVersion = 2;
  assert.throws(() => validateFrontendWebsiteRuntime(schema), /not compatible/i);

  const old = validPayload();
  old.websiteRuntime.foundationVersion = "2.0.0";
  assert.throws(() => validateFrontendWebsiteRuntime(old), /not 3\.0\.0/i);
});

test("checks the deployed frontend SHA without rejecting normal abbreviated git SHAs", () => {
  assert.equal(gitShaMatches("0123456789abcdef", "0123456"), true);
  assert.equal(gitShaMatches("0123456", "0123456789abcdef"), true);
  assert.equal(gitShaMatches("fedcba9876543210", "0123456"), false);
  assert.throws(() => validateFrontendWebsiteRuntime(validPayload(), { expectedSha: "fedcba9" }), /SHA mismatch/);
});

test("requires HTTPS outside localhost and strips any deployment path", () => {
  assert.equal(normalizeFrontendOrigin("https://app.example.com/some/path"), "https://app.example.com");
  assert.equal(normalizeFrontendOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => normalizeFrontendOrigin("http://app.example.com"), /requires HTTPS/);
  assert.throws(() => normalizeFrontendOrigin("https://user:pass@app.example.com"), /credentials/);
});

test("reads /api/version with no-store semantics and validates the response", async () => {
  let called;
  const fetchImpl = async (url, options) => {
    called = { url, options };
    return { ok: true, status: 200, json: async () => validPayload() };
  };
  const result = await verifyFrontendWebsiteRuntime({
    origin: "https://app.example.com",
    expectedSha: "0123456",
    fetchImpl,
  });
  assert.equal(called.url, "https://app.example.com/api/version");
  assert.equal(called.options.cache, "no-store");
  assert.equal(result.foundationVersion, "3.0.0");
});
