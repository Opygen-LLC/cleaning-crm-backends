import { describe, expect, it } from "vitest";
import { isPublicProviderAddress } from "./websiteDomainProvider.service";

describe("custom-domain TLS probe address safety", () => {
  it("rejects private, loopback, link-local and documentation networks", () => {
    for (const address of [
      "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
      "192.168.1.1", "100.64.0.1", "198.18.0.1", "203.0.113.10",
      "::1", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1",
    ]) {
      expect(isPublicProviderAddress(address), address).toBe(false);
    }
  });

  it("allows public provider addresses", () => {
    expect(isPublicProviderAddress("8.8.8.8")).toBe(true);
    expect(isPublicProviderAddress("2606:4700:4700::1111")).toBe(true);
  });
});
