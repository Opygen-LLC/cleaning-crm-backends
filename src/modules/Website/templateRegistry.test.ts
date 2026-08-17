import { describe, expect, it } from "vitest";
import { TemplateRegistry } from "./templateRegistry";

describe("TemplateRegistry", () => {
  it("keeps template versions explicit and stable", () => {
    const template = TemplateRegistry.requireTemplate("clean-modern", "1.0.0");
    expect(template.id).toBe("clean-modern");
    expect(template.version).toBe("1.0.0");
    expect(template.schemaVersion).toBe(1);
  });

  it("resolves a versionless template deterministically", () => {
    expect(TemplateRegistry.requireTemplate("clean-modern").version).toBe("1.0.0");
  });

  it("rejects unknown versions rather than silently upgrading tenants", () => {
    expect(() => TemplateRegistry.requireTemplate("clean-modern", "9.9.9")).toThrow();
  });

  it("does not expose mutable registry state to callers", () => {
    const copy = TemplateRegistry.requireTemplate("clean-modern", "1.0.0");
    copy.capabilities.booking = false;

    expect(TemplateRegistry.requireTemplate("clean-modern", "1.0.0").capabilities.booking).toBe(true);
  });
});
