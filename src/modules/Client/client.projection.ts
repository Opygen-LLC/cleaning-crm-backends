import { Prisma } from "../../generated/prisma/client";

export const clientListSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  servicePreference: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  zipcode: true,
  country: true,
  totalSpend: true,
  totalBookings: true,
  lastBookingDate: true,
  createdAt: true,
} satisfies Prisma.ClientSelect;

export const clientLookupSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  zipcode: true,
  country: true,
} satisfies Prisma.ClientSelect;

export const clientDetailSelect = {
  ...clientListSelect,
  portalAccessToken: true,
  updatedAt: true,
  notes: {
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      text: true,
      createdAt: true,
    },
  },
  bookings: {
    orderBy: { scheduledDate: "desc" as const },
    take: 100,
    select: {
      id: true,
      bookingRef: true,
      serviceType: true,
      serviceNameSnapshot: true,
      scheduledDate: true,
      status: true,
      total: true,
      invoice: {
        select: {
          id: true,
          invoiceRef: true,
          status: true,
          total: true,
          dueDate: true,
          paidDate: true,
        },
      },
    },
  },
} satisfies Prisma.ClientSelect;

export const clientMutationSelect = {
  id: true,
  updatedAt: true,
} satisfies Prisma.ClientSelect;
