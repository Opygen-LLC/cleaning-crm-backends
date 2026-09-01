import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Phase 1 staff workflow contracts", () => {
  it("keeps the required staff route matrix role-gated", () => {
    const dashboard = read("src/modules/Dashboard/dashboard.routes.ts");
    const staff = read("src/modules/Staff/staff.routes.ts");
    const jobs = read("src/modules/Job/job.routes.ts");
    const leave = read("src/modules/StaffLeave/staffLeave.routes.ts");

    expect(dashboard).toContain('router.get(\n  "/staff",\n  checkAuth(UserRole.STAFF)');
    expect(staff).toContain('router.get("/me", checkAuth(UserRole.STAFF)');
    expect(staff).toContain('router.patch("/me", checkAuth(UserRole.STAFF)');
    expect(staff).not.toContain('checkAuth(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.STAFF)');
    expect(jobs).toContain('router.get("/", checkAuth(UserRole.ADMIN, UserRole.STAFF)');
    expect(jobs).toContain('router.get("/:id", checkAuth(UserRole.ADMIN, UserRole.STAFF)');
    expect(jobs).toContain('checkAuth(UserRole.ADMIN, UserRole.STAFF),\n    zodValidate(jobValidation.updateStatus');
    expect(jobs).toContain('router.post("/:id/checkin", checkAuth(UserRole.STAFF, UserRole.ADMIN)');
    expect(jobs).toContain('router.post("/:id/checkout", checkAuth(UserRole.STAFF, UserRole.ADMIN)');
    expect(leave).toContain('"/leave",\n  checkAuth(UserRole.STAFF)');
  });

  it("requires a valid StaffProfile, tenant and assignment before staff job access", () => {
    const auth = read("src/middlewares/checkAuth.ts");
    const jobs = read("src/modules/Job/job.service.ts");

    expect(auth).toContain('code: "STAFF_PROFILE_MISSING"');
    expect(auth).toContain('code: "FORBIDDEN"');
    expect(jobs).toContain('adminId: staffProfile.adminId');
    expect(jobs).toContain('staffAssignments: { some: { staffId: staffProfile.id } }');
    expect(jobs).toContain('code: "STAFF_JOB_NOT_ASSIGNED"');
    expect(jobs).toContain('job: { adminId: staffProfile.adminId }');
  });

  it("uses a compact staff dashboard projection and explicit dashboard errors", () => {
    const service = read("src/modules/Dashboard/dashboard.service.ts");
    const controller = read("src/modules/Dashboard/dashboard.controller.ts");

    const projection = service.slice(
      service.indexOf("const staffDashboardJobSelect"),
      service.indexOf("const getStaffDashboard"),
    );
    expect(projection).toContain("client: { select: { name: true, phone: true } }");
    expect(projection).not.toContain("checklists");
    expect(projection).not.toContain("email: true");
    expect(controller).toContain('code: "STAFF_DASHBOARD_UNAVAILABLE"');
    expect(service).toContain('code: "STAFF_PROFILE_MISSING"');
  });

  it("validates staff specialisations against the owning tenant catalogue", () => {
    const staff = read("src/modules/Staff/staff.service.ts");
    expect(staff).toContain("validateStaffSpecialties");
    expect(staff).toContain('status: "ACTIVE"');
    expect(staff).toContain('serviceName: { in: normalized }');
    expect(staff).toContain('code: "INVALID_STAFF_SPECIALTY"');
    expect(staff).toContain("await prisma.user.delete({ where: { id: userId } })");
  });

  it("provides the lightweight client booking-prefill contract", () => {
    const routes = read("src/modules/Client/client.routes.ts");
    const service = read("src/modules/Client/client.service.ts");
    expect(routes).toContain('"/detail/:id/booking-prefill"');
    expect(service).toContain("getClientBookingPrefill");
    expect(service).toContain("addressLine1: true");
    expect(service).toContain("addressLine2: true");
  });
  it("keeps staff job sub-resources assignment-scoped and cache-coherent", () => {
    const notes = read("src/modules/Job/job.notes.service.ts");
    const cache = read("src/lib/cache/resourceCacheVersion.ts");
    const privateCache = read("src/middlewares/privateResponseCache.ts");
    const jobController = read("src/modules/Job/job.controller.ts");
    const leaveController = read("src/modules/StaffLeave/staffLeave.controller.ts");

    expect(notes).toContain("resolveAdminIdForJob(user, jobId)");
    expect(notes).toContain("jobId, staffId: staff.id");
    expect(cache).toContain('jobs: "jobs"');
    expect(cache).toContain('staff: "staff"');
    expect(privateCache).toContain('if (path.includes("/job")) return CacheResource.jobs');
    expect(privateCache).toContain('if (path.includes("/staff")) return CacheResource.staff');
    expect(jobController).toContain("CacheResource.jobs, CacheResource.dashboard");
    expect(leaveController).toContain("CacheResource.staff, CacheResource.dashboard");
  });

});
