import { describe, expect, it } from "vitest";
import { classifyError } from "./errorClassification";

describe("error classification", () => {
  it("separates expected auth bootstrap from expired sessions", () => {
    expect(classifyError(401, "ACCESS_TOKEN_MISSING")).toBe("AUTH_BOOTSTRAP");
    expect(classifyError(401, "ACCESS_TOKEN_EXPIRED")).toBe("AUTH_EXPIRED");
  });

  it("classifies tenant resolution failure as an invariant", () => {
    expect(classifyError(500, "TENANT_CONTEXT_RESOLUTION_FAILED")).toBe("TENANT_INVARIANT");
  });

  it("separates permission, not-found, lifecycle and validation failures", () => {
    expect(classifyError(403, "FORBIDDEN")).toBe("PERMISSION");
    expect(classifyError(404, "NOT_FOUND")).toBe("NOT_FOUND");
    expect(classifyError(409, "CONFLICT")).toBe("LIFECYCLE_CONFLICT");
    expect(classifyError(422, "VALIDATION_ERROR")).toBe("VALIDATION");
  });
});
