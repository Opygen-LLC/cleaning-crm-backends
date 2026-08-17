import { describe, expect, it } from "vitest";
import { parseWebsiteBackfillArgs } from "./backfillBusinessWebsites";

describe("parseWebsiteBackfillArgs", () => {
  it("supports dry-run and bounded operational controls", () => {
    expect(
      parseWebsiteBackfillArgs(["--dry-run", "--batch-size=250", "--max-attempts=4"]),
    ).toEqual({
      dryRun: true,
      batchSize: 250,
      maxAttempts: 4,
    });
  });

  it("rejects unsafe oversized values by falling back to defaults", () => {
    expect(parseWebsiteBackfillArgs(["--batch-size=9999", "--max-attempts=50"])).toEqual({
      dryRun: false,
      batchSize: 100,
      maxAttempts: 3,
    });
  });
});
