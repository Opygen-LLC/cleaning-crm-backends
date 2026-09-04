import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Phase 5 security and tenant isolation contracts", () => {
  it("protects every Super Admin route with the SUPER_ADMIN middleware", () => {
    const routes = read("src/modules/SuperAdmin/superAdmin.routes.ts");
    expect(routes).toContain("const isSuperAdmin = checkAuth(UserRole.SUPER_ADMIN)");
    const statements = routes.match(/router\.(?:get|post|patch|put|delete)\([\s\S]*?\);/g) ?? [];
    expect(statements.length).toBeGreaterThan(20);
    for (const statement of statements) expect(statement).toContain("isSuperAdmin");
  });

  it("preserves self-protection and final-Super-Admin protection", () => {
    const service = read("src/modules/SuperAdmin/tenantAdmin.service.ts");
    expect(service).toContain("A Super Admin cannot permanently delete their own account");
    expect(service).toContain("You cannot suspend your own Super Admin account");
    expect(service).toContain("The final Super Admin cannot be demoted");
  });

  it("binds tenant-owned IDs to the authenticated organization before mutations", () => {
    const sources = {
      staff: read("src/modules/Staff/staff.service.ts"),
      client: read("src/modules/Client/client.service.ts"),
      job: read("src/modules/Job/job.service.ts"),
      booking: read("src/modules/Booking/booking.service.ts"),
      service: read("src/modules/ServiceCatalog/serviceCatalog.service.ts"),
      website: read("src/modules/Website/website.service.ts"),
      subscription: read("src/modules/Subscription/subscription.service.ts"),
      payment: read("src/modules/Payment/payment.service.ts"),
    };
    for (const key of ["staff", "client", "job", "booking", "service", "payment"] as const) expect(sources[key]).toContain("adminId");
    expect(sources.staff).toContain("where: { id, adminId }");
    expect(sources.client).toContain("where: { id, adminId }");
    expect(sources.job).toContain("where: { id, adminId }");
    expect(sources.booking).toContain("where: { id, adminId }");
    expect(sources.service).toContain("where: { id, adminId }");
    expect(sources.payment).toContain("where: { id, adminId }");
    expect(sources.website).toContain("getAdminId(");
    expect(sources.website).toContain("where: { id, adminId }");
    expect(sources.subscription).toContain("resolveAdminProfileId(user)");
    expect(sources.subscription).toContain("tenantHistoryWhere = { subscription: { adminId } }");
  });

  it("blocks PENDING_DELETION across login, dashboard, public access/writes, workers, notifications and scheduled jobs", () => {
    const auth = read("src/modules/Auth/auth.service.ts");
    const middleware = read("src/middlewares/checkAuth.ts");
    const subscriptionGate = read("src/middlewares/checkSubscription.ts");
    const access = read("src/modules/Entitlement/tenantAccessResolver.service.ts");
    const publicWebsite = read("src/modules/Website/publicWebsite.service.ts");
    const bookingForm = read("src/modules/BookingForm/bookingForm.service.ts");
    const estimateForm = read("src/modules/EstimateForm/estimateForm.service.ts");
    const notificationWorker = read("src/workers/emailOutbox.worker.ts");
    const recurringBooking = read("src/cron/recurringBooking.cron.ts");
    const staffStatus = read("src/cron/staffStatus.cron.ts");
    const bookingReminder = read("src/cron/bookingReminder.cron.ts");
    const invoiceOverdue = read("src/cron/invoiceOverdue.cron.ts");

    expect(auth).toContain("PENDING_DELETION");
    expect(middleware).toContain("PENDING_DELETION");
    expect(subscriptionGate).toContain("TenantAccessResolver.resolve");
    expect(access).toContain('publicWritesAllowed: accessState.dashboardAllowed');
    expect(access).toContain('backgroundJobsAllowed: accessState.dashboardAllowed');
    expect(publicWebsite).toContain("publicWebsiteAllowed");
    expect(bookingForm).toContain("publicWritesAllowed");
    expect(estimateForm).toContain("publicWritesAllowed");
    expect(notificationWorker).toContain("backgroundJobsAllowed");
    expect(notificationWorker).toContain('status: "CANCELLED"');
    for (const scheduledJob of [recurringBooking, staffStatus, bookingReminder, invoiceOverdue]) {
      expect(scheduledJob).toContain("TenantAccessResolver.resolve");
      expect(scheduledJob).toContain("backgroundJobsAllowed");
    }
  });
});
