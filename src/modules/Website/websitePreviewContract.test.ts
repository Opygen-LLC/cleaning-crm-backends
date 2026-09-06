import { describe, expect, it } from "vitest";
import { websiteValidation } from "./website.validation";

const expected = { websiteId: "00000000-0000-4000-8000-000000000001", draftRevisionNumber: 8, profileVersion: "a".repeat(64) };
describe("private preview wire contract with backend Zod 4", () => {
  it("keeps the existing Studio editor preview compatible", () => {
    expect(websiteValidation.previewSession.safeParse({ website: { primaryColor: "#123456" }, pages: [] }).success).toBe(true);
  });
  it("accepts an exact saved revision without overrides", () => {
    expect(websiteValidation.previewSession.parse({ expected, website: {}, pages: [] })).toMatchObject({ expected });
  });
  it("cannot label unsaved editor overrides as a saved preview", () => {
    expect(websiteValidation.previewSession.safeParse({ expected, website: { primaryColor: "#123456" } }).success).toBe(false);
  });
  it.each([{ draftRevisionNumber: -1 }, { draftRevisionNumber: 2.5 }, { profileVersion: "partial" }, { websiteId: "not-a-uuid" }])("rejects malformed expectation %j", patch => {
    expect(websiteValidation.previewSession.safeParse({ expected: { ...expected, ...patch } }).success).toBe(false);
  });
});
