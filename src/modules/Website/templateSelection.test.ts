import { describe, expect, it } from "vitest";
import { buildTemplateSelectionPatch } from "./templateSelection";

describe("buildTemplateSelectionPatch", () => {
  it("changes presentation identity only", () => {
    const patch = buildTemplateSelectionPatch(
      { templateId: "premium-home", templateVersion: "1.0.0" },
      { templateId: "clean-modern", templateVersion: "1.0.0" },
    );

    expect(patch).toEqual({
      templateId: "premium-home",
      templateVersion: "1.0.0",
      schemaVersion: 1,
    });
    expect(Object.keys(patch).sort()).toEqual(["schemaVersion", "templateId", "templateVersion"]);
    expect(patch).not.toHaveProperty("pages");
    expect(patch).not.toHaveProperty("primaryBookingFormId");
    expect(patch).not.toHaveProperty("logo");
    expect(patch).not.toHaveProperty("services");
    expect(patch).not.toHaveProperty("reviews");
  });

  it("returns no database patch when template identity was not requested", () => {
    expect(buildTemplateSelectionPatch({}, {
      templateId: "clean-modern",
      templateVersion: "1.0.0",
    })).toEqual({});
  });

  it("rejects an unavailable explicit version rather than silently migrating", () => {
    expect(() => buildTemplateSelectionPatch(
      { templateId: "premium-home", templateVersion: "9.9.9" },
      { templateId: "clean-modern", templateVersion: "1.0.0" },
    )).toThrow();
  });
});
