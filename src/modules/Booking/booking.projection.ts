import type { Prisma } from "../../generated/prisma/client";

/** Stable list/calendar contract. Never expose tenant ids or relation graphs. */
export const bookingListSelect = {
  id: true,
  bookingRef: true,
  status: true,
  serviceType: true,
  serviceCatalogId: true,
  serviceNameSnapshot: true,
  address: true,
  scheduledDate: true,
  durationMins: true,
  total: true,
  notes: true,
  clientId: true,
  quoteId: true,
  createdAt: true,
  client: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      latitude: true,
      longitude: true,
    },
  },
  staffAssignments: {
    select: {
      staff: {
        select: {
          id: true,
          staffRole: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  },
  job: { select: { id: true, jobRef: true, status: true } },
  quote: { select: { id: true, quoteRef: true } },
  serviceCatalog: { select: { id: true, serviceName: true } },
} satisfies Prisma.BookingSelect;

export const bookingDetailSelect = {
  ...bookingListSelect,
  priceSnapshot: true,
  durationSnapshot: true,
  addOnSnapshot: true,
  updatedAt: true,
  sourceBookingFormSubmission: {
    select: {
      ref: true,
      source: true,
      sourcePage: true,
      propertyType: true,
      bedrooms: true,
      bathrooms: true,
      answers: true,
      addOnSnapshot: true,
    },
  },
} satisfies Prisma.BookingSelect;

export const bookingMutationSelect = {
  id: true,
  bookingRef: true,
  status: true,
  scheduledDate: true,
  updatedAt: true,
} satisfies Prisma.BookingSelect;
