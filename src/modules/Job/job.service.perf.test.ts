import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    job: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    staffProfile: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    adminProfile: {
      findUnique: vi.fn(),
    },
    client: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    quote: {
      findFirst: vi.fn(),
    },
    estimate: {
      findFirst: vi.fn(),
    },
    booking: {
      findFirst: vi.fn(),
    },
    jobStaffAssignment: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    reviewToken: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb({
      jobStaffAssignment: {
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
      job: {
        findUnique: vi.fn(),
        update: vi.fn().mockImplementation(({ data }) => ({
          id: "job-1",
          jobRef: "#OP-JB-0001",
          adminId: "admin-profile-1",
          clientId: "client-1",
          status: data.status,
          serviceType: "RESIDENTIAL_CLEANING",
          scheduledDate: new Date(),
          staffAssignments: [{ staffId: "staff-1", staff: { user: { name: "John Staff" } } }],
        })),
      },
      booking: {
        update: vi.fn(),
        findUnique: vi.fn(),
      },
      reviewToken: {
        upsert: vi.fn(),
      },
      invoice: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    })),
  },
}));

vi.mock("../../lib/notifications/businessNotificationEvents", () => ({
  queueReviewRequestNotification: vi.fn().mockResolvedValue({ queued: true, deliveryId: "delivery-1" }),
  queueStaffAssignedNotifications: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../config/socketio", () => ({
  emitToAdmin: vi.fn(),
  emitToStaff: vi.fn(),
}));

vi.mock("../../lib/utils/createNotification", () => ({
  createNotification: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../lib/utils/geocoding", () => ({
  geocodeAddressSafely: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "../../lib/prisma/prisma";
import { jobService } from "./job.service";
import { IRequestUser } from "../../types/requestUser.interface";
import { JobStatus, UserRole } from "../../generated/prisma/enums";
import { queueReviewRequestNotification } from "../../lib/notifications/businessNotificationEvents";

describe("Job Service Performance Fixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getAllJobs for STAFF role returns paginated result with meta and data", async () => {
    const mockStaffUser: IRequestUser = {
      id: "user-staff-1",
      email: "staff@example.com",
      role: UserRole.STAFF,
      adminId: "admin-1",
    };

    (prisma.staffProfile.findUnique as any).mockResolvedValue({
      id: "staff-profile-1",
      userId: "user-staff-1",
    });

    (prisma.job.findMany as any).mockResolvedValue([
      { id: "job-1", jobRef: "#OP-JB-0001", adminId: "admin-1" },
    ]);
    (prisma.job.count as any).mockResolvedValue(1);

    const result = await jobService.getAllJobs({ page: "1", limit: "10" }, mockStaffUser);

    expect(prisma.staffProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-staff-1" },
    });
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("meta");
    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(10);
    expect(result.meta.total).toBe(1);
  });

  it("getAdminId uses req.user.adminId fast path without querying adminProfile", async () => {
    const mockAdminUser: IRequestUser = {
      id: "user-admin-1",
      email: "admin@example.com",
      role: UserRole.ADMIN,
      adminId: "admin-profile-1",
    };

    (prisma.job.count as any).mockResolvedValue(5);

    const stats = await jobService.getJobStats(mockAdminUser);

    expect(stats.total).toBe(5);
    // Uncached resolveAdminId query to adminProfile should NOT have been called
    expect(prisma.adminProfile.findUnique).not.toHaveBeenCalled();
  });

  it("updateJobStatus queues a durable review request when COMPLETED", async () => {
    const mockAdminUser: IRequestUser = {
      id: "user-admin-1",
      email: "admin@example.com",
      role: UserRole.ADMIN,
      adminId: "admin-profile-1",
    };

    const mockJob = {
      id: "job-1",
      jobRef: "#OP-JB-0001",
      adminId: "admin-profile-1",
      clientId: "client-1",
      status: JobStatus.IN_PROGRESS,
      serviceType: "RESIDENTIAL_CLEANING",
      scheduledDate: new Date(),
      staffAssignments: [{ staff: { user: { name: "John Staff" } } }],
    };

    (prisma.job.findFirst as any).mockResolvedValue(mockJob);
    (prisma.job.update as any).mockResolvedValue({ ...mockJob, status: JobStatus.COMPLETED });
    (prisma.reviewToken.findUnique as any).mockResolvedValue({ token: "rev-123" });
    (prisma.client.findUnique as any).mockResolvedValue({ name: "Jane Client", email: "client@example.com" });

    const result = await jobService.updateJobStatus("job-1", JobStatus.COMPLETED, mockAdminUser);

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(queueReviewRequestNotification).toHaveBeenCalledWith(
      "job-1",
      expect.stringContaining("/review/rev-123"),
      "initial",
    );
  });
});
