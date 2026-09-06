import { describe, expect, it } from "vitest";
import { TemplateRegistry } from "./templateRegistry";

describe("TemplateRegistry", () => {
  it("keeps template versions explicit and stable", () => {
    const template = TemplateRegistry.requireTemplate("clean-modern", "1.0.0");
    expect(template.key).toBe("clean-modern@1.0.0");
    expect(template.id).toBe("clean-modern");
    expect(template.version).toBe("1.0.0");
    expect(template.schemaVersion).toBe(1);
  });

  it("resolves a versionless template deterministically", () => {
    expect(TemplateRegistry.requireTemplate("clean-modern").version).toBe("2.0.0");
  });

  it("retains all original versions alongside the refreshed runtime contracts", () => {
    expect(TemplateRegistry.list().map((template) => template.key).sort()).toEqual([
      "clean-modern@1.0.0",
      "clean-modern@2.0.0",
      "commercial-pro@1.0.0",
      "commercial-pro@2.0.0",
      "local-cleaning@1.0.0",
      "local-cleaning@2.0.0",
      "premium-home@1.0.0",
      "premium-home@2.0.0",
    ]);
  });

  it("describes template positioning without storing tenant business data in the registry", () => {
    const premium = TemplateRegistry.requireTemplate("premium-home", "1.0.0");
    const commercial = TemplateRegistry.requireTemplate("commercial-pro", "1.0.0");
    const local = TemplateRegistry.requireTemplate("local-cleaning", "1.0.0");

    expect(premium.highlights).toContain("Large imagery");
    expect(commercial.bestFor).toContain("Office cleaning");
    expect(local.highlights).toContain("Visible service prices");
  });

  it("rejects unknown versions rather than silently upgrading tenants", () => {
    expect(() => TemplateRegistry.requireTemplate("clean-modern", "9.9.9")).toThrow();
  });

  it("does not expose mutable registry state to callers", () => {
    const copy = TemplateRegistry.requireTemplate("clean-modern", "1.0.0");
    copy.capabilities.booking = false;
    (copy.bestFor as string[]).push("Mutated outside registry");
    (copy.highlights as string[])[0] = "Mutated";

    const fresh = TemplateRegistry.requireTemplate("clean-modern", "1.0.0");
    expect(fresh.capabilities.booking).toBe(true);
    expect(fresh.bestFor).not.toContain("Mutated outside registry");
    expect(fresh.highlights[0]).not.toBe("Mutated");
  });
});
