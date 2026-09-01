import { Prisma } from "../../generated/prisma/client";

/** Lean row used by roster/list screens. Never exposes tenant/security fields. */
export const staffListSelect = {
  id: true,
  staffRole: true,
  mobileNumber: true,
  address: true,
  hourlyRate: true,
  startDate: true,
  specialty: true,
  status: true,
  userId: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
    },
  },
} satisfies Prisma.StaffProfileSelect;

/** Minimal row for assignee/typeahead controls. */
export const staffLookupSelect = {
  id: true,
  staffRole: true,
  specialty: true,
  status: true,
  userId: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
    },
  },
} satisfies Prisma.StaffProfileSelect;

/** Admin detail row. Includes only fields actually rendered by staff detail/edit. */
export const staffDetailSelect = {
  ...staffListSelect,
  emergencyName: true,
  emergencyMobileNumber: true,
  adminNote: true,
  updatedAt: true,
  staffAvailability: {
    select: {
      day: true,
      startTime: true,
      endTime: true,
      isActive: true,
    },
    orderBy: { day: "asc" as const },
  },
} satisfies Prisma.StaffProfileSelect;

export const staffMutationSelect = {
  id: true,
  userId: true,
  updatedAt: true,
} satisfies Prisma.StaffProfileSelect;
