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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveAdminId = async (user: any): Promise<string> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
  return admin.id;
};

const generatePaymentRef = async (): Promise<string> => {
  const last = await prisma.payment.findFirst({
    orderBy: { createdAt: "desc" },
    select: { paymentRef: true },
  });
  let nextNum = 1;
  if (last?.paymentRef) {
    const parts = last.paymentRef.split("-");
    const num = parseInt(parts[parts.length - 1]);
    if (!isNaN(num)) nextNum = num + 1;
  }
  return `#OP-PAY-${nextNum.toString().padStart(4, "0")}`;
};

// ─── Create Payment — POST /payment ──────────────────────────────────────────

const createPayment = async (payload: IPaymentCreate, user: any) => {
  const adminId = await resolveAdminId(user);

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

  const paymentRef = await generatePaymentRef();
  const paidAt = payload.paidAt ? new Date(payload.paidAt) : new Date();

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        paymentRef,
        amount: payload.amount,
        method: payload.method,
        status: PaymentStatus.PAID,
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
        paymentRef,
        amount: Number(payload.amount),
      });
    } catch { /* socket not yet initialised — non-fatal */ }

    createNotification({
      adminId,
      type: NotificationType.PAYMENT,
      title: `Invoice marked as PAID`,
      message: `All payments for this invoice have been received (total £${Number(result.invoice.total ?? 0).toFixed(2)})`,
      relatedId: result.payment.id,
    }).catch(() => {});
  } else if (payload.invoiceId) {
    // Payment recorded but invoice not yet fully covered
    createNotification({
      adminId,
      type: NotificationType.PAYMENT,
      title: `Payment recorded`,
      message: `${payload.method} payment of £${Number(payload.amount).toFixed(2)} recorded`,
      relatedId: result.payment.id,
    }).catch(() => {});
  }

  logActivity({
    adminId,
    action: "CREATE_PAYMENT",
    entityType: "Payment",
    entityId: result.payment.id,
    description: `Created payment ${paymentRef} — ${payload.method} £${Number(payload.amount).toFixed(2)}`,
  });

  return result;
};

// ─── Get All Payments — GET /payment ─────────────────────────────────────────

const getAllPayments = async (filters: IPaymentFilters, user: any) => {
  const adminId = user.role === UserRole.SUPER_ADMIN
    ? undefined
    : await resolveAdminId(user);

  const where: any = {};
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

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
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
  ]);

  // Compute stats
  const totalCollected = payments
    .filter((p) => p.status === PaymentStatus.PAID)
    .reduce((sum, p) => sum + Number(p.amount), 0);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthPayments = payments.filter(
    (p) => p.paidAt && new Date(p.paidAt) >= startOfMonth && p.status === PaymentStatus.PAID,
  );
  const thisMonth = thisMonthPayments.reduce((s, p) => s + Number(p.amount), 0);
  const avgPayment = payments.length ? totalCollected / payments.length : 0;

  // Group by method
  const methodMap = new Map<string, { amount: number; count: number }>();
  payments.forEach((p) => {
    const key = p.method as string;
    const existing = methodMap.get(key) ?? { amount: 0, count: 0 };
    methodMap.set(key, {
      amount: existing.amount + Number(p.amount),
      count: existing.count + 1,
    });
  });
  const byMethod = [...methodMap.entries()].map(([method, data]) => ({
    method,
    ...data,
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
    stats: { totalCollected, thisMonth, avgPayment, byMethod },
  };
};

// ─── Get Payment By ID — GET /payment/:id ────────────────────────────────────

const getPaymentById = async (id: string, user: any) => {
  const adminId = user.role === UserRole.SUPER_ADMIN
    ? undefined
    : await resolveAdminId(user);

  const where: any = { id };
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

const updatePayment = async (id: string, payload: IPaymentUpdate, user: any) => {
  const adminId = await resolveAdminId(user);

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

  return updated;
};

// ─── Delete Payment — DELETE /payment/:id ────────────────────────────────────

const deletePayment = async (id: string, user: any) => {
  const adminId = await resolveAdminId(user);

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

  return { success: true };
};

// ─── Upload Receipt — PATCH /payment/:id/receipt ─────────────────────────────

const uploadReceipt = async (
  id: string,
  file: Express.Multer.File,
  user: any,
) => {
  const adminId = await resolveAdminId(user);

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
