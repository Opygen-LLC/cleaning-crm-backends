import { describe, expect, it } from "vitest";
import { WEBSITE_STATUS, isWebsiteLifecycleStatus, statusAfterDraftMutation } from "./websiteLifecycle";

describe("website lifecycle", () => {
  it("defines the canonical four lifecycle states", () => {
    expect(Object.values(WEBSITE_STATUS)).toEqual(["PROVISIONED", "DRAFT", "PUBLISHED", "SUSPENDED"]);
    for (const value of Object.values(WEBSITE_STATUS)) expect(isWebsiteLifecycleStatus(value)).toBe(true);
  });

  it("moves a provisioned website to draft on its first edit", () => {
    expect(statusAfterDraftMutation(WEBSITE_STATUS.PROVISIONED)).toBe(WEBSITE_STATUS.DRAFT);
  });

  it("keeps a live website published while its working draft changes", () => {
    expect(statusAfterDraftMutation(WEBSITE_STATUS.PUBLISHED)).toBe(WEBSITE_STATUS.PUBLISHED);
  });
});
