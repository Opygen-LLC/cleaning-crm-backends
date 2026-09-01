import type { Prisma } from "../../generated/prisma/client";

const jobBaseSelect = {
  id: true,
  jobRef: true,
  status: true,
  serviceType: true,
  serviceCatalogId: true,
  serviceNameSnapshot: true,
  address: true,
  latitude: true,
  longitude: true,
  scheduledDate: true,
  durationMins: true,
  notes: true,
  clientId: true,
  quoteId: true,
  estimateId: true,
  bookingId: true,
  createdAt: true,
  client: { select: { id: true, name: true, email: true, phone: true } },
} satisfies Prisma.JobSelect;

/** Admin list contract: enough for tables/dispatch, no tenant/security graph. */
export const jobListSelect = {
  ...jobBaseSelect,
  serviceCatalog: { select: { id: true, serviceName: true } },
  staffAssignments: {
    select: {
      staffId: true,
      staff: { select: { id: true, user: { select: { id: true, name: true, email: true } } } },
    },
  },
  booking: { select: { id: true, bookingRef: true, status: true } },
  quote: { select: { id: true, quoteRef: true } },
  estimate: { select: { id: true, estimateRef: true } },
} satisfies Prisma.JobSelect;

/** Staff list/detail contract deliberately omits other staff and commercial relations. */
export const staffJobSelect = {
  ...jobBaseSelect,
  serviceCatalog: { select: { id: true, serviceName: true } },
} satisfies Prisma.JobSelect;

export const jobDetailSelect = {
  ...jobListSelect,
  updatedAt: true,
  staffAssignments: {
    select: {
      staffId: true,
      assignedAt: true,
      checkInAt: true,
      checkOutAt: true,
      hoursWorked: true,
      staff: {
        select: {
          id: true,
          staffRole: true,
          mobileNumber: true,
          specialty: true,
          status: true,
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    },
  },
} satisfies Prisma.JobSelect;

export const jobMutationSelect = {
  id: true,
  jobRef: true,
  status: true,
  scheduledDate: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;
