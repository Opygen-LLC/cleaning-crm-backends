import { prisma } from "../../lib/prisma/prisma";
import { IPaymentCreate, IPaymentFilters, IPaymentUpdate } from "./payment.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import {
  UserRole,
  PaymentStatus,
  InvoiceStatus,
} from "../../generated/prisma/enums";
import { uploadFileToCloudinary } from "../../config/cloudinary";
import { logActivity } from "../../lib/utils/logActivity";
import { createNotification } from "../../lib/utils/createNotification";
import { NotificationType } from "../../generated/prisma/enums";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { invalidateAnalyticsCache } from "../../lib/utils/invalidateAnalyticsCache";
import { nextReference } from "../../lib/utils/referenceNumber";
import { formatMoney } from "../../lib/utils/money";
import { IRequestUser } from "../../types/requestUser.interface";
import logger from "../../lib/logger";
import type { Prisma } from "../../generated/prisma/client";

// ─── Create Payment — POST /payment ──────────────────────────────────────────

const createPayment = async (payload: IPaymentCreate, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const admin = await prisma.adminProfile.findUnique({
    where: { id: adminId },
    select: { currency: true },
  });
  if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

  // If linked to an invoice, validate ownership
  if (payload.invoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: { id: payload.invoiceId, adminId },
    });
    if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");
    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new AppError(status.BAD_REQUEST, "Cannot record payment on a cancelled invoice");
    }
  }

  const paidAt = payload.paidAt ? new Date(payload.paidAt) : new Date();

  const result = await prisma.$transaction(async (tx) => {
    const paymentRef = await nextReference(tx, "payment");
    const payment = await tx.payment.create({
      data: {
        paymentRef,
        amount: payload.amount,
        method: payload.method,
        status: PaymentStatus.PAID,
        currency: admin.currency,
        note: payload.note,
        transactionId: payload.transactionId,
        paidAt,
        adminId,
        invoiceId: payload.invoiceId ?? null,
      },
    });

    // Auto-mark invoice PAID only when cumulative PAID payments >= invoice total
    let updatedInvoice = null;
    if (payload.invoiceId) {
      const invoice = await tx.invoice.findUnique({
        where: { id: payload.invoiceId },
        select: { total: true, status: true },
      });

      if (invoice && invoice.status !== InvoiceStatus.PAID) {
        // Sum all previously recorded PAID payments for this invoice
        // (the new payment is already in the DB at this point because
        //  the create above ran in the same transaction)
        const aggregate = await tx.payment.aggregate({
          where: {
            invoiceId: payload.invoiceId,
            status: PaymentStatus.PAID,
          },
          _sum: { amount: true },
        });

        const totalPaid = Number(aggregate._sum.amount ?? 0);
        const invoiceTotal = Number(invoice.total);

        if (totalPaid >= invoiceTotal) {
          updatedInvoice = await tx.invoice.update({
            where: { id: payload.invoiceId },
            data: { status: InvoiceStatus.PAID, paidDate: paidAt },
          });
        }
      }
    }

    return { payment, invoice: updatedInvoice };
  });

  // Notifications (non-blocking)
  if (payload.invoiceId && result.invoice) {
    // Invoice just flipped to PAID — emit socket event to admin dashboard
    try {
      const { emitToAdmin } = await import("../../config/socketio");
      emitToAdmin(adminId, "invoice:paid", {
        invoiceId: payload.invoiceId,
        paymentRef: result.payment.paymentRef,
        amount: Number(payload.amount),
      });
    } catch (error) {
      logger.warn("payment_socket_emit_failed", {
        adminId,
        invoiceId: payload.invoiceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    createNotification({
      adminId,
      type: NotificationType.PAYMENT,
      title: `Invoice marked as PAID`,
      message: `All payments for this invoice have been received (total ${formatMoney(result.invoice.total ?? 0, admin.currency)})`,
      relatedId: result.payment.id,
    }).catch(() => {});
  } else if (payload.invoiceId) {
    // Payment recorded but invoice not yet fully covered
    createNotification({
      adminId,
      type: NotificationType.PAYMENT,
      title: `Payment recorded`,
      message: `${payload.method} payment of ${formatMoney(payload.amount, admin.currency)} recorded`,
      relatedId: result.payment.id,
    }).catch(() => {});
  }

  logActivity({
    adminId,
    action: "CREATE_PAYMENT",
    entityType: "Payment",
    entityId: result.payment.id,
    description: `Created payment ${result.payment.paymentRef} — ${payload.method} ${formatMoney(payload.amount, admin.currency)}`,
  });
  invalidateAnalyticsCache(adminId);

  return result;
};

// ─── Get All Payments — GET /payment ─────────────────────────────────────────

const getAllPayments = async (filters: IPaymentFilters, user: IRequestUser) => {
  const adminId = user.role === UserRole.SUPER_ADMIN
    ? undefined
    : await getAdminId(user);

  const where: Prisma.PaymentWhereInput = {};
  if (adminId) where.adminId = adminId;

  if (filters.method)   where.method = filters.method;
  if (filters.status)   where.status = filters.status;
  if (filters.invoiceId) where.invoiceId = filters.invoiceId;

  if (filters.startDate || filters.endDate) {
    where.paidAt = {};
    if (filters.startDate) where.paidAt.gte = new Date(filters.startDate);
    if (filters.endDate)   where.paidAt.lte = new Date(filters.endDate);
  }

  if (filters.searchTerm) {
    where.OR = [
      { paymentRef:  { contains: filters.searchTerm, mode: "insensitive" } },
      { note:        { contains: filters.searchTerm, mode: "insensitive" } },
      { transactionId: { contains: filters.searchTerm, mode: "insensitive" } },
      {
        invoice: {
          OR: [
            { invoiceRef:  { contains: filters.searchTerm, mode: "insensitive" } },
            { clientName:  { contains: filters.searchTerm, mode: "insensitive" } },
          ],
        },
      },
    ];
  }

  const safePage = Math.max(1, Number(filters.page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(filters.limit) || 10));
  const skip = (safePage - 1) * safeLimit;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const paidWhere = { ...where, status: PaymentStatus.PAID };

  const [payments, total, paidAggregate, thisMonthAggregate, byMethodRows] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: safeLimit,
      include: {
        invoice: {
          select: {
            invoiceRef: true,
            clientName: true,
          },
        },
      },
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({
      where: paidWhere,
      _sum: { amount: true },
      _avg: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { ...paidWhere, paidAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.payment.groupBy({
      by: ["method"],
      where: paidWhere,
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const totalCollected = Number(paidAggregate._sum.amount ?? 0);
  const thisMonth = Number(thisMonthAggregate._sum.amount ?? 0);
  const avgPayment = Number(paidAggregate._avg.amount ?? 0);
  const byMethod = byMethodRows.map((row) => ({
    method: row.method,
    amount: Number(row._sum.amount ?? 0),
    count: row._count._all,
  }));

  return {
    payments: payments.map((p) => ({
      id:             p.id,
      paymentRef:     p.paymentRef,
      invoiceRef:     p.invoice?.invoiceRef ?? null,
      clientName:     p.invoice?.clientName ?? null,
      amount:         Number(p.amount),
      method:         p.method,
      status:         p.status,
      date:           p.paidAt?.toISOString() ?? p.createdAt.toISOString(),
      note:           p.note,
      transactionId:  p.transactionId,
      paymentProofUrl: p.paymentProofUrl,
      invoiceId:      p.invoiceId,
    })),
    total,
    meta: {
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    },
    stats: { totalCollected, thisMonth, avgPayment, byMethod },
  };
};

// ─── Get Payment By ID — GET /payment/:id ────────────────────────────────────

const getPaymentById = async (id: string, user: IRequestUser) => {
  const adminId = user.role === UserRole.SUPER_ADMIN
    ? undefined
    : await getAdminId(user);

  const where: Prisma.PaymentWhereInput = { id };
  if (adminId) where.adminId = adminId;

  const payment = await prisma.payment.findFirst({
    where,
    include: {
      invoice: {
        select: { invoiceRef: true, clientName: true, clientEmail: true, total: true },
      },
    },
  });

  if (!payment) throw new AppError(status.NOT_FOUND, "Payment not found");
  return payment;
};

// ─── Update Payment — PATCH /payment/:id ─────────────────────────────────────

const updatePayment = async (id: string, payload: IPaymentUpdate, user: IRequestUser) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.payment.findFirst({ where: { id, adminId } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Payment not found");

  const updated = await prisma.payment.update({
    where: { id },
    data: {
      ...(payload.amount      !== undefined && { amount: payload.amount }),
      ...(payload.method      !== undefined && { method: payload.method }),
      ...(payload.status      !== undefined && { status: payload.status }),
      ...(payload.note        !== undefined && { note: payload.note }),
      ...(payload.transactionId !== undefined && { transactionId: payload.transactionId }),
      ...(payload.paidAt      !== undefined && { paidAt: new Date(payload.paidAt) }),
    },
  });

  logActivity({
    adminId,
    action: "UPDATE_PAYMENT",
    entityType: "Payment",
    entityId: id,
    description: `Updated payment ${existing.paymentRef}`,
  });
  invalidateAnalyticsCache(adminId);

  return updated;
};

// ─── Delete Payment — DELETE /payment/:id ────────────────────────────────────

const deletePayment = async (id: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.payment.findFirst({ where: { id, adminId } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Payment not found");

  await prisma.payment.delete({ where: { id } });

  logActivity({
    adminId,
    action: "DELETE_PAYMENT",
    entityType: "Payment",
    entityId: id,
    description: `Deleted payment ${existing.paymentRef}`,
  });
  invalidateAnalyticsCache(adminId);

  return { success: true };
};

// ─── Upload Receipt — PATCH /payment/:id/receipt ─────────────────────────────

const uploadReceipt = async (
  id: string,
  file: Express.Multer.File,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  const existing = await prisma.payment.findFirst({ where: { id, adminId } });
  if (!existing) throw new AppError(status.NOT_FOUND, "Payment not found");

  const cloudinaryResult = await uploadFileToCloudinary(
    file.buffer,
    file.originalname,
  );

  const updated = await prisma.payment.update({
    where: { id },
    data: { paymentProofUrl: cloudinaryResult.secure_url },
  });

  logActivity({
    adminId,
    action: "UPLOAD_RECEIPT",
    entityType: "Payment",
    entityId: id,
    description: `Uploaded receipt for payment ${existing.paymentRef}`,
  });

  return { receiptUrl: cloudinaryResult.secure_url, payment: updated };
};

export const paymentService = {
  createPayment,
  getAllPayments,
  getPaymentById,
  updatePayment,
  deletePayment,
  uploadReceipt,
};
