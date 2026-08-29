import { describe, expect, it } from "vitest";
import { API_MODULE_CONTRACTS } from "./endpointContract";

describe("API module contract boundary", () => {
  it("has unique module paths and explicit request/response/error/role contracts", () => {
    const paths = API_MODULE_CONTRACTS.map((entry) => entry.basePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const entry of API_MODULE_CONTRACTS) {
      expect(entry.basePath.startsWith("/")).toBe(true);
      expect(entry.roles.length).toBeGreaterThan(0);
      expect(entry.requestContract.length).toBeGreaterThan(3);
      expect(entry.responseContract.length).toBeGreaterThan(3);
      expect(entry.errorContract).toBe("TErrorResponse");
    }
  });
});
