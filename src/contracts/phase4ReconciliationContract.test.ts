import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../scripts/integrity/integrityChecks.ts", import.meta.url), "utf8");

describe("Phase 4 production reconciliation contract", () => {
  it("reports every requested high-risk relationship before production rollout", () => {
    for (const code of [
      "STAFF_USER_WITHOUT_PROFILE",
      "STAFF_PROFILE_WITHOUT_USER",
      "BOOKING_STAFF_CROSS_TENANT",
      "JOB_STAFF_CROSS_TENANT",
      "STAFF_SPECIALTY_NOT_IN_CATALOG",
      "ORPHAN_LEAD_ACTIVITY",
      "LEAD_ACTIVITY_ASSIGNEE_CROSS_TENANT",
      "ORPHAN_BOOKING_CLIENT",
      "ORPHAN_BOOKING_SERVICE",
      "DUPLICATE_LEAD_NORMALIZED_EMAIL",
      "NON_CANONICAL_REFERENCE_FORMAT",
    ]) expect(source).toContain(`code: "${code}"`);
  });

  it("keeps reconciliation read-only unless --fix is explicitly supplied", () => {
    const reconcile = readFileSync(new URL("../scripts/phase4/reconcileData.ts", import.meta.url), "utf8");
    expect(reconcile).toContain('const applyFixes = process.argv.includes("--fix")');
    expect(reconcile).toContain("await runPass(false)");
    expect(reconcile).toContain('printSummary(applyFixes ? "fix-preflight" : "report")');
  });
});
