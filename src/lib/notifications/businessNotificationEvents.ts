import { FRONTEND_URL } from "../../config/ENV";
import { prisma } from "../prisma/prisma";
import { formatMoney } from "../utils/money";
import { BusinessNotificationOutbox } from "../outbox/businessNotificationOutbox";
import type { BusinessNotificationTemplateKey } from "./businessNotificationRegistry";

const fmtDate = (value: Date) =>
  new Date(value).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const fmtTime = (value: Date) =>
  new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

const serviceName = (value: {
  serviceNameSnapshot?: string | null;
  serviceType?: unknown;
  serviceCatalog?: { serviceName?: string | null } | null;
}) => value.serviceCatalog?.serviceName || value.serviceNameSnapshot || String(value.serviceType || "Cleaning service");

export const queueBookingNotification = async (
  bookingId: string,
  templateKey: "booking-confirmation" | "booking-reminder-24h" | "booking-reminder-day-of",
  occurrence?: string,
) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      bookingRef: true,
      adminId: true,
      address: true,
      scheduledDate: true,
      serviceType: true,
      serviceNameSnapshot: true,
      serviceCatalog: { select: { serviceName: true } },
      client: { select: { name: true, email: true } },
    },
  });
  if (!booking?.client.email) return { queued: false as const, deliveryId: null };

  const scheduleOccurrence = occurrence ?? booking.scheduledDate.toISOString();
  const eventKey = templateKey === "booking-confirmation"
    ? `booking-confirmation:${booking.id}`
    : `${templateKey}:${booking.id}:${scheduleOccurrence}`;

  return BusinessNotificationOutbox.enqueue({
    adminId: booking.adminId,
    eventKey,
    templateKey,
    recipientEmail: booking.client.email,
    entityType: "Booking",
    entityId: booking.id,
    variables: {
      clientName: booking.client.name,
      bookingRef: booking.bookingRef,
      bookingDate: fmtDate(booking.scheduledDate),
      bookingTime: fmtTime(booking.scheduledDate),
      serviceType: serviceName(booking),
      address: booking.address,
    },
  });
};

export const queueStaffAssignedNotifications = async (
  jobId: string,
  staffIds: string[],
) => {
  if (!staffIds.length) return [];
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      jobRef: true,
      adminId: true,
      clientId: true,
      address: true,
      scheduledDate: true,
      serviceType: true,
      serviceNameSnapshot: true,
      serviceCatalog: { select: { serviceName: true } },
      client: { select: { name: true } },
    },
  });
  if (!job) return [];

  const [staff, assignments] = await Promise.all([
    prisma.staffProfile.findMany({
      where: { adminId: job.adminId, id: { in: staffIds } },
      select: { id: true, user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.jobStaffAssignment.findMany({
      where: { jobId: job.id, staffId: { in: staffIds } },
      select: { staffId: true, assignedAt: true },
    }),
  ]);
  const assignmentTime = new Map(assignments.map((item) => [item.staffId, item.assignedAt.toISOString()]));
  const jobLink = `${FRONTEND_URL}/staff/dashboard/jobs/${job.id}`;

  return Promise.all(staff.map((member) => BusinessNotificationOutbox.enqueue({
    adminId: job.adminId,
    eventKey: `staff-assigned:${job.id}:${member.id}:${assignmentTime.get(member.id) ?? "current"}`,
    templateKey: "staff-assigned",
    recipientEmail: member.user.email,
    recipientUserId: member.user.id,
    entityType: "Job",
    entityId: job.id,
    variables: {
      staffName: member.user.name,
      jobRef: job.jobRef,
      clientName: job.client.name,
      serviceType: serviceName(job),
      bookingDate: fmtDate(job.scheduledDate),
      bookingTime: fmtTime(job.scheduledDate),
      address: job.address,
      jobLink,
    },
  })));
};

export const queueQuoteSentNotification = async (quoteId: string, occurrence: string) => {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true, quoteRef: true, publicToken: true, adminId: true, total: true, validUntil: true,
      serviceType: true, serviceNameSnapshot: true,
      serviceCatalog: { select: { serviceName: true } },
      client: { select: { name: true, email: true } },
      admin: { select: { currency: true } },
    },
  });
  if (!quote?.client.email) return { queued: false as const, deliveryId: null };
  const quoteLink = quote.publicToken ? `${FRONTEND_URL}/quote/${encodeURIComponent(quote.publicToken)}` : "";
  return BusinessNotificationOutbox.enqueue({
    adminId: quote.adminId,
    eventKey: `quote-sent:${quote.id}:${occurrence}`,
    templateKey: "quote-sent",
    recipientEmail: quote.client.email,
    entityType: "Quote",
    entityId: quote.id,
    variables: {
      clientName: quote.client.name,
      quoteRef: quote.quoteRef,
      serviceType: serviceName(quote),
      quoteTotal: formatMoney(quote.total, quote.admin.currency),
      validUntil: fmtDate(quote.validUntil),
      quoteLink,
    },
  });
};

export const queueInvoiceNotification = async (
  invoiceId: string,
  templateKey: "invoice-sent" | "invoice-due",
  occurrence: string,
) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true, invoiceRef: true, adminId: true, clientName: true, clientEmail: true,
      serviceNameSnapshot: true, total: true, dueDate: true,
      admin: { select: { currency: true } },
    },
  });
  if (!invoice?.clientEmail) return { queued: false as const, deliveryId: null };
  return BusinessNotificationOutbox.enqueue({
    adminId: invoice.adminId,
    eventKey: `${templateKey}:${invoice.id}:${occurrence}`,
    templateKey,
    recipientEmail: invoice.clientEmail,
    entityType: "Invoice",
    entityId: invoice.id,
    variables: {
      clientName: invoice.clientName,
      invoiceRef: invoice.invoiceRef,
      serviceType: invoice.serviceNameSnapshot || "Cleaning service",
      invoiceAmount: formatMoney(invoice.total, invoice.admin.currency),
      dueDate: fmtDate(invoice.dueDate),
      invoiceLink: `${FRONTEND_URL}/invoice/${encodeURIComponent(invoice.invoiceRef)}`,
    },
  });
};

export const queueReviewRequestNotification = async (
  jobId: string,
  reviewUrl: string,
  occurrence = "initial",
) => {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true, jobRef: true, adminId: true, scheduledDate: true,
      serviceType: true, serviceNameSnapshot: true,
      serviceCatalog: { select: { serviceName: true } },
      client: { select: { name: true, email: true } },
      staffAssignments: { select: { staff: { select: { user: { select: { name: true } } } } } },
    },
  });
  if (!job?.client.email) return { queued: false as const, deliveryId: null };
  return BusinessNotificationOutbox.enqueue({
    adminId: job.adminId,
    eventKey: `review-request:${job.id}:${occurrence}`,
    templateKey: "review-request",
    recipientEmail: job.client.email,
    entityType: "Job",
    entityId: job.id,
    variables: {
      clientName: job.client.name,
      jobRef: job.jobRef,
      serviceType: serviceName(job),
      completedDate: fmtDate(job.scheduledDate),
      staffName: job.staffAssignments.map((item) => item.staff.user.name).join(", "),
      reviewLink: reviewUrl,
    },
  });
};

export type QueueableBusinessTemplateKey = BusinessNotificationTemplateKey;
