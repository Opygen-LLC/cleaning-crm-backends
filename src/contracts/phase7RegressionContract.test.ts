import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(relative, "utf8");

describe("Phase 7 regression and cleanup contract", () => {
  it("keeps auth verification on the durable outbox and canonical session surface", () => {
    const loginTest = read("src/modules/Auth/auth.service.login.test.ts");
    const provisioning = read("src/modules/Auth/accountProvisioning.service.ts");
    const authRoutes = read("src/modules/Auth/auth.route.ts");

    expect(loginTest).toContain("EMAIL_NOT_VERIFIED");
    expect(provisioning).toMatch(/enqueue|outbox/i);
    expect(authRoutes).toContain('"/sessions"');
    expect(authRoutes).toContain('"/sessions/:id"');
    expect(authRoutes).toContain('"/sessions/revoke-others"');
    expect(existsSync("src/modules/Session/session.routes.ts")).toBe(false);
  });

  it("keeps avatar upload dedicated and file constrained", () => {
    const routes = read("src/modules/User/user.routes.ts");
    const service = read("src/modules/User/user.service.ts");
    const multer = read("src/config/multerMemory.ts");

    expect(routes).toContain('"/me/avatar"');
    expect(routes).toContain('multerMemory.single("avatar")');
    expect(routes).not.toMatch(/router\.patch\([\s\S]*?"\/:id"[\s\S]*?multerMemory/);
    expect(service).toContain("ALLOWED_AVATAR_TYPES");
    expect(multer).toContain("fileSize: 10 * 1024 * 1024");
  });

  it("invalidates cache generations for client, lead and booking mutation paths", () => {
    for (const file of [
      "src/modules/Client/client.controller.ts",
      "src/modules/Lead/lead.controller.ts",
      "src/modules/Booking/booking.controller.ts",
    ]) {
      const source = read(file);
      expect(source).toContain("bumpCacheResourcesForUser");
    }
    const booking = read("src/modules/Booking/booking.controller.ts");
    expect(booking).toContain("CacheResource.dashboard");
  });

  it("keeps new-client estimate creation transactional", () => {
    const validation = read("src/modules/Estimate/estimate.validation.ts");
    const service = read("src/modules/Estimate/estimate.service.ts");
    expect(validation).toContain("Choose exactly one client mode");
    expect(service).toContain("prisma.$transaction");
    expect(service).toContain("payload.newClient");
  });

  it("keeps public quote read/respond unauthenticated and token scoped", () => {
    const routes = read("src/modules/Quote/quote.public.routes.ts");
    const service = read("src/modules/Quote/quote.service.ts");
    expect(routes).toContain('router.get("/:token"');
    expect(routes).toContain('"/:token/action"');
    expect(routes).not.toContain("checkAuth(");
    expect(service).toContain("publicToken");
    expect(service).toMatch(/expires|expired|validUntil/i);
  });

  it("uses the canonical notification registry without legacy runtime aliases", () => {
    const registry = read("src/lib/notifications/businessNotificationRegistry.ts");
    const email = read("src/lib/email.ts");
    for (const key of [
      "booking-confirmation",
      "booking-reminder-24h",
      "booking-reminder-day-of",
      "staff-assigned",
      "quote-sent",
      "invoice-sent",
      "invoice-due",
      "review-request",
    ]) expect(registry).toContain(key);
    for (const legacy of ["staff-job-dispatch", "quote-send", "invoice-send", '"reminder-24h"']) {
      expect(email).not.toContain(legacy);
    }
  });

  it("has no database Website Studio draft or first-party visitor analytics route", () => {
    const websiteRoutes = read("src/modules/Website/website.routes.ts");
    const publicRoutes = read("src/modules/Website/publicWebsite.routes.ts");
    expect(websiteRoutes).not.toContain('"/draft"');
    expect(websiteRoutes).not.toContain('"/analytics"');
    expect(publicRoutes).not.toContain('"/:identifier/analytics"');
    expect(websiteRoutes).toContain('"/publish"');
    expect(websiteRoutes).toContain('"/launch"');
    expect(websiteRoutes).toContain('"/preview"');
  });

  it("exposes production observability for performance, email and operations", () => {
    const server = read("src/server.ts");
    expect(server).toContain('"/health/performance"');
    expect(server).toContain('"/health/email-outbox"');
    expect(server).toContain('"/health/operations"');
  });
});
