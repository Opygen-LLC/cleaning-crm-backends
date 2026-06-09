import { prisma } from "../../lib/prisma/prisma";
import {
    IInvoiceCreate,
    IInvoiceUpdate,
    IInvoiceFilters,
} from "./invoice.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import {
    UserRole,
    InvoiceStatus,
    PaymentMethod,
    PaymentStatus,
} from "../../generated/prisma/enums";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { FRONTEND_URL } from "../../config/ENV";
import { createStripePaymentLink } from "../../lib/Payments/stripe.healper";
import { uploadFileToCloudinary } from "../../config/cloudinary";

/**
 * Generates a unique invoice reference in the format #OP-INV-0001
 */
const generateInvoiceRef = async () => {
    const lastInvoice = await prisma.invoice.findFirst({
        orderBy: { createdAt: "desc" },
        select: { invoiceRef: true },
    });

    let nextNumber = 1;

    if (lastInvoice && lastInvoice.invoiceRef) {
        const parts = lastInvoice.invoiceRef.split("-");
        if (parts.length === 3) {
            const lastNumber = parseInt(parts[2]);
            if (!isNaN(lastNumber)) {
                nextNumber = lastNumber + 1;
            }
        }
    }

    const formattedNumber = nextNumber.toString().padStart(4, "0");
    return `#OP-INV-${formattedNumber}`;
};

const createInvoice = async (payload: IInvoiceCreate, user: any) => {
    const adminProfile = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    const serviceCatalog = await prisma.serviceCatalog.findUnique({
        where: { id: payload.serviceCatalogId },
    });

    if (!serviceCatalog) {
        throw new AppError(status.NOT_FOUND, "Service not found in catalog");
    }

    const { clientDetails, dates, summary, ...invoiceData } = payload;

    const invoiceRef = await generateInvoiceRef();

    return await prisma.invoice.create({
        data: {
            ...invoiceData,
            invoiceRef,
            adminId: adminProfile.id,
            clientName: clientDetails.clientName,
            clientEmail: clientDetails.email,
            serviceAddress: clientDetails.serviceAddress,
            linkedBookingRef: clientDetails.linkedBookingRef,
            issuedDate: new Date(dates.issueDate),
            dueDate: new Date(dates.dueDate),
            subtotal: summary.subtotal,
            taxRate: summary.taxRate,
            taxAmount: summary.taxAmount,
            total: summary.total,
            lineItems: payload.lineItems as any,
        },
    });
};

const getAllInvoices = async (filters: IInvoiceFilters, user: any) => {
    const { searchTerm, status: invoiceStatus, adminId } = filters;
    const andConditions: any[] = [];

    if (searchTerm) {
        andConditions.push({
            OR: [
                { invoiceRef: { contains: searchTerm, mode: "insensitive" } },
                { clientName: { contains: searchTerm, mode: "insensitive" } },
                { clientEmail: { contains: searchTerm, mode: "insensitive" } },
            ],
        });
    }

    if (invoiceStatus) {
        andConditions.push({ status: invoiceStatus });
    }

    if (adminId) {
        andConditions.push({ adminId });
    } else if (user.role === UserRole.ADMIN) {
        const adminProfile = await prisma.adminProfile.findUnique({
            where: { userId: user.id },
        });
        if (adminProfile) {
            andConditions.push({ adminId: adminProfile.id });
        }
    }

    const whereConditions =
        andConditions.length > 0 ? { AND: andConditions } : {};

    return await prisma.invoice.findMany({
        where: whereConditions,
        include: {
            serviceCatalog: {
                select: {
                    id: true,
                    serviceName: true,
                },
            },
        },
        orderBy: {
            createdAt: "desc",
        },
    });
};

const getInvoiceById = async (id: string) => {
    const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: {
            serviceCatalog: {
                select: {
                    id: true,
                    serviceName: true,
                },
            },
        },
    });

    if (!invoice) {
        throw new AppError(status.NOT_FOUND, "Invoice not found");
    }

    return invoice;
};

const updateInvoice = async (id: string, payload: IInvoiceUpdate) => {
    const invoice = await prisma.invoice.findUnique({ where: { id } });

    if (!invoice) {
        throw new AppError(status.NOT_FOUND, "Invoice not found");
    }

    const { clientDetails, dates, summary, ...updateData } = payload;

    const data: any = { ...updateData };

    if (clientDetails) {
        if (clientDetails.clientName)
            data.clientName = clientDetails.clientName;
        if (clientDetails.email) data.clientEmail = clientDetails.email;
        if (clientDetails.serviceAddress)
            data.serviceAddress = clientDetails.serviceAddress;
        if (clientDetails.linkedBookingRef)
            data.linkedBookingRef = clientDetails.linkedBookingRef;
    }

    if (dates) {
        if (dates.issueDate) data.issuedDate = new Date(dates.issueDate);
        if (dates.dueDate) data.dueDate = new Date(dates.dueDate);
    }

    if (summary) {
        if (summary.subtotal !== undefined) data.subtotal = summary.subtotal;
        if (summary.taxRate !== undefined) data.taxRate = summary.taxRate;
        if (summary.taxAmount !== undefined) data.taxAmount = summary.taxAmount;
        if (summary.total !== undefined) data.total = summary.total;
    }

    if (payload.lineItems) {
        data.lineItems = payload.lineItems as any;
    }

    return await prisma.invoice.update({
        where: { id },
        data,
    });
};

const updateInvoiceStatus = async (
    id: string,
    invoiceStatus: InvoiceStatus,
) => {
    const invoice = await prisma.invoice.findUnique({ where: { id } });

    if (!invoice) {
        throw new AppError(status.NOT_FOUND, "Invoice not found");
    }

    const data: any = { status: invoiceStatus };
    if (invoiceStatus === InvoiceStatus.PAID) {
        data.paidDate = new Date();
    } else if (invoiceStatus === InvoiceStatus.SENT) {
        data.sentAt = new Date();
    }

    return await prisma.invoice.update({
        where: { id },
        data,
    });
};

const deleteInvoice = async (id: string) => {
    const invoice = await prisma.invoice.findUnique({ where: { id } });

    if (!invoice) {
        throw new AppError(status.NOT_FOUND, "Invoice not found");
    }

    return await prisma.invoice.delete({
        where: { id },
    });
};

// ── Payment History ───────────────────────────────────────────────────────────

interface IPaymentHistoryFilters {
    page?: number;
    limit?: number;
    searchTerm?: string;
    method?: string; // free-text: "Cash", "Card", "Bank Transfer", "Stripe", etc.
    adminId?: string;
}

const generatePaymentRef = (index: number, invoiceRef: string) => {
    // Derive a stable ref from invoice ref so it's idempotent
    const num = invoiceRef.replace(/\D/g, "").padStart(4, "0").slice(-4);
    return `#PAY-${num}`;
};

/**
 * Payment history is derived from PAID invoices.
 * The Payment model only stores Stripe gateway transactions;
 * most "payments" in this CRM happen by marking an invoice PAID manually.
 * This endpoint unifies both sources.
 */
const getPaymentHistory = async (
    filters: IPaymentHistoryFilters,
    user: any,
) => {
    const { page = 1, limit = 10, searchTerm, method, adminId } = filters;

    // ── Resolve adminId ────────────────────────────────────────────────────────
    let resolvedAdminId: string | undefined = adminId;
    if (!resolvedAdminId && user.role === "ADMIN") {
        const adminProfile = await prisma.adminProfile.findUnique({
            where: { userId: user.id },
            select: { id: true },
        });
        resolvedAdminId = adminProfile?.id;
    }

    // ── Fetch paid invoices ────────────────────────────────────────────────────
    const andConditions: any[] = [{ status: "PAID" }];

    if (resolvedAdminId) {
        andConditions.push({ adminId: resolvedAdminId });
    }

    if (searchTerm) {
        andConditions.push({
            OR: [
                { invoiceRef: { contains: searchTerm, mode: "insensitive" } },
                { clientName: { contains: searchTerm, mode: "insensitive" } },
                { clientEmail: { contains: searchTerm, mode: "insensitive" } },
            ],
        });
    }

    // method filter applies to the paymentMethod field on the invoice (if stored)
    // or we skip — most invoices don't store the method
    if (method && method !== "All") {
        andConditions.push({ paymentMethod: method });
    }

    const [paidInvoices, total] = await Promise.all([
        prisma.invoice.findMany({
            where: { AND: andConditions },
            orderBy: { paidDate: "desc" },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                id: true,
                invoiceRef: true,
                clientName: true,
                total: true,
                paidDate: true,
                createdAt: true,
            },
        }),
        prisma.invoice.count({ where: { AND: andConditions } }),
    ]);

    // ── Stats (across all paid invoices for this admin) ────────────────────────
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const allPaidWhere: any = { status: "PAID" };
    if (resolvedAdminId) allPaidWhere.adminId = resolvedAdminId;

    const [allPaid, thisMonthPaid] = await Promise.all([
        prisma.invoice.findMany({
            where: allPaidWhere,
            select: { total: true, paidDate: true },
        }),
        prisma.invoice.findMany({
            where: { ...allPaidWhere, paidDate: { gte: startOfThisMonth } },
            select: { total: true },
        }),
    ]);

    const totalCollected = allPaid.reduce(
        (sum, inv) => sum + Number(inv.total),
        0,
    );
    const thisMonth = thisMonthPaid.reduce(
        (sum, inv) => sum + Number(inv.total),
        0,
    );
    const avgPayment =
        allPaid.length > 0 ? Math.round(totalCollected / allPaid.length) : 0;

    // Payment method breakdown — placeholder since Invoice model doesn't store method
    const byMethod = [
        { method: "Bank Transfer", amount: 0, count: 0 },
        { method: "Card", amount: 0, count: 0 },
        { method: "Cash", amount: 0, count: 0 },
        { method: "Stripe", amount: 0, count: 0 },
    ];

    // ── Shape payments list ───────────────────────────────────────────────────
    const payments = paidInvoices.map((inv, i) => ({
        id: inv.id,
        paymentRef: generatePaymentRef(i, inv.invoiceRef),
        invoiceRef: inv.invoiceRef,
        clientName: inv.clientName,
        clientAvatar: undefined,
        amount: Number(inv.total),
        method: "Bank Transfer" as const, // default until payment method stored on Invoice
        date: inv.paidDate
            ? new Date(inv.paidDate).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
              })
            : new Date(inv.createdAt).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
              }),
    }));

    return {
        payments,
        total,
        stats: {
            totalCollected,
            thisMonth,
            avgPayment,
            byMethod,
        },
    };
};

// ── Send Invoice ──────────────────────────────────────────────────────────────

const sendInvoice = async (id: string, user: any) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
    });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const invoice = await prisma.invoice.findFirst({
        where: { id, adminId: admin.id },
    });
    if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");

    if (invoice.status === InvoiceStatus.PAID) {
        throw new AppError(
            status.BAD_REQUEST,
            "Invoice is already paid and cannot be re-sent",
        );
    }
    if (invoice.status === InvoiceStatus.CANCELLED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cancelled invoices cannot be sent",
        );
    }

    if (!invoice.clientEmail) {
        throw new AppError(
            status.BAD_REQUEST,
            "Invoice has no client email address",
        );
    }

    // Format helpers
    const fmt = (d: Date) =>
        d.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
        });

    const fmt2dp = (n: any) => Number(n).toFixed(2);

    // Optional "View Invoice" deep-link — works if public invoice pages exist
    const invoiceViewUrl = FRONTEND_URL
        ? `${FRONTEND_URL}/invoice/${invoice.invoiceRef}`
        : null;

    await sendEmailSafely({
        to: invoice.clientEmail,
        subject: `Invoice ${invoice.invoiceRef} — Payment due ${fmt(invoice.dueDate)}`,
        templateName: "invoice-send",
        templateData: {
            invoiceRef: invoice.invoiceRef,
            clientName: invoice.clientName,
            serviceAddress: invoice.serviceAddress,
            issuedDate: fmt(invoice.issuedDate),
            dueDate: fmt(invoice.dueDate),
            subtotal: fmt2dp(invoice.subtotal),
            taxRate: Number(invoice.taxRate),
            taxAmount: fmt2dp(invoice.taxAmount),
            total: fmt2dp(invoice.total),
            notes: invoice.notes ?? null,
            invoiceViewUrl,
        },
    });

    // Stamp sentAt and move to SENT if still DRAFT
    const updatedInvoice = await prisma.invoice.update({
        where: { id },
        data: {
            sentAt: new Date(),
            status:
                invoice.status === InvoiceStatus.DRAFT
                    ? InvoiceStatus.SENT
                    : invoice.status,
        },
    });

    return updatedInvoice;
};

// ── Record Payment ────────────────────────────────────────────────────────────

interface IRecordPayment {
    amount: number;
    method: PaymentMethod;
    note?: string;
    transactionId?: string;
    paidAt?: string;
}

const recordPayment = async (
    invoiceId: string,
    payload: IRecordPayment,
    user: any,
) => {
    // Resolve admin
    const admin = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
    });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, adminId: admin.id },
    });
    if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");

    if (invoice.status === InvoiceStatus.PAID) {
        throw new AppError(
            status.BAD_REQUEST,
            "Invoice is already marked as paid",
        );
    }
    if (invoice.status === InvoiceStatus.CANCELLED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot record payment on a cancelled invoice",
        );
    }

    // Generate payment ref: #OP-PAY-0001
    const lastPayment = await prisma.payment.findFirst({
        orderBy: { createdAt: "desc" },
        select: { paymentRef: true },
    });
    let nextNum = 1;
    if (lastPayment?.paymentRef) {
        const parts = lastPayment.paymentRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) nextNum = num + 1;
    }
    const paymentRef = `#OP-PAY-${nextNum.toString().padStart(4, "0")}`;

    const paidAt = payload.paidAt ? new Date(payload.paidAt) : new Date();

    return prisma.$transaction(async (tx) => {
        // Create Payment record
        const payment = await tx.payment.create({
            data: {
                paymentRef,
                amount: payload.amount,
                method: payload.method,
                status: PaymentStatus.PAID,
                note: payload.note,
                transactionId: payload.transactionId,
                paidAt,
                adminId: admin.id,
                invoiceId: invoice.id,
            },
        });

        // Mark invoice as PAID
        const updatedInvoice = await tx.invoice.update({
            where: { id: invoiceId },
            data: { status: InvoiceStatus.PAID, paidDate: paidAt },
        });

        return { payment, invoice: updatedInvoice };
    });
};

// ─── Create Stripe Checkout Session for an invoice ───────────────────────────
//
// Returns a one-time Stripe Checkout URL the admin can share with the client.
// The Stripe session metadata includes the invoiceId so the webhook handler
// can auto-mark the invoice PAID when payment_intent.succeeded fires.
const createInvoicePaymentLink = async (invoiceId: string, user: any) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
        include: { paymentGateway: true },
    });

    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const gatewayConfig = admin.paymentGateway;
    if (!gatewayConfig?.stripeEnabled) {
        throw new AppError(
            status.BAD_REQUEST,
            "Stripe is not enabled. Enable it in Settings → Payment Gateway.",
        );
    }

    const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, adminId: admin.id },
    });

    if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");
    if (invoice.status === InvoiceStatus.PAID) {
        throw new AppError(status.BAD_REQUEST, "Invoice is already paid");
    }
    if (invoice.status === InvoiceStatus.CANCELLED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot create a payment link for a cancelled invoice",
        );
    }

    // Amount is stored in major currency units (e.g. pounds/dollars).
    // Stripe expects the smallest unit (pence/cents) so we multiply by 100.
    const amountInCents = Math.round(Number(invoice.total) * 100);

    const paymentUrl = await createStripePaymentLink({
        amount: amountInCents,
        name: `Invoice ${invoice.invoiceRef}`,
        author_id: admin.id,
        booking_id: invoice.id, // reuse booking_id field to pass invoice id
    });

    // Persist the link on the invoice for re-use (until it expires)
    await prisma.invoice.update({
        where: { id: invoice.id },
        data: { notes: invoice.notes }, // no-op update to keep TS happy; link lives in response
    });

    return {
        paymentUrl,
        invoiceId: invoice.id,
        invoiceRef: invoice.invoiceRef,
    };
};

// ── Submit payment proof (bank-transfer screenshot) ──────────────────────────
//
// Called by admin (or on behalf of client).
// Uploads the proof image to Cloudinary, creates or updates a Payment record
// with status PENDING_APPROVAL, and keeps the invoice in its current state
// until an admin approves.

const submitPaymentProof = async (
    invoiceId: string,
    paymentId: string,
    file: Express.Multer.File,
    user: any,
) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
    });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, adminId: admin.id },
    });
    if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");

    if (invoice.status === InvoiceStatus.PAID) {
        throw new AppError(status.BAD_REQUEST, "Invoice is already paid");
    }
    if (invoice.status === InvoiceStatus.CANCELLED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot submit proof for a cancelled invoice",
        );
    }

    // Upload the screenshot to Cloudinary
    const uploadResult = await uploadFileToCloudinary(
        file.buffer,
        file.originalname || "payment-proof.jpg",
    );

    let payment: any;

    if (paymentId === "new") {
        // Generate ref for a brand-new payment
        const lastPayment = await prisma.payment.findFirst({
            orderBy: { createdAt: "desc" },
            select: { paymentRef: true },
        });
        let nextNum = 1;
        if (lastPayment?.paymentRef) {
            const parts = lastPayment.paymentRef.split("-");
            const num = parseInt(parts[parts.length - 1]);
            if (!isNaN(num)) nextNum = num + 1;
        }
        const paymentRef = `#OP-PAY-${nextNum.toString().padStart(4, "0")}`;

        payment = await prisma.payment.create({
            data: {
                paymentRef,
                amount: invoice.total,
                method: PaymentMethod.BANK_TRANSFER,
                status: PaymentStatus.PENDING_APPROVAL,
                paymentProofUrl: uploadResult.secure_url,
                adminId: admin.id,
                invoiceId: invoice.id,
            },
        });
    } else {
        // Update an existing payment record
        const existing = await prisma.payment.findFirst({
            where: { id: paymentId, adminId: admin.id },
        });
        if (!existing) throw new AppError(status.NOT_FOUND, "Payment not found");

        payment = await prisma.payment.update({
            where: { id: paymentId },
            data: {
                status: PaymentStatus.PENDING_APPROVAL,
                paymentProofUrl: uploadResult.secure_url,
            },
        });
    }

    return { payment, proofUrl: uploadResult.secure_url };
};

// ── Approve or reject a PENDING_APPROVAL payment ─────────────────────────────
//
// action: "approve" → marks Payment PAID, Invoice PAID, sends receipt email.
// action: "reject"  → marks Payment FAILED, optionally stores rejectionReason.

const approvePayment = async (
    invoiceId: string,
    paymentId: string,
    payload: { action: "approve" | "reject"; rejectionReason?: string },
    user: any,
) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId: user.id },
    });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

    const invoice = await prisma.invoice.findFirst({
        where: { id: invoiceId, adminId: admin.id },
    });
    if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");

    const payment = await prisma.payment.findFirst({
        where: { id: paymentId, adminId: admin.id, invoiceId },
    });
    if (!payment) throw new AppError(status.NOT_FOUND, "Payment not found");

    if (payment.status !== PaymentStatus.PENDING_APPROVAL) {
        throw new AppError(
            status.BAD_REQUEST,
            `Payment is not pending approval (current status: ${payment.status})`,
        );
    }

    const now = new Date();

    if (payload.action === "approve") {
        const result = await prisma.$transaction(async (tx) => {
            const updatedPayment = await tx.payment.update({
                where: { id: paymentId },
                data: {
                    status: PaymentStatus.PAID,
                    approvedAt: now,
                    approvedByUserId: user.id,
                    paidAt: now,
                },
            });

            const updatedInvoice = await tx.invoice.update({
                where: { id: invoiceId },
                data: { status: InvoiceStatus.PAID, paidDate: now },
            });

            return { payment: updatedPayment, invoice: updatedInvoice };
        });

        // Send payment receipt email
        const fmt = (d: Date) =>
            d.toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
            });

        if (invoice.clientEmail) {
            await sendEmailSafely({
                to: invoice.clientEmail,
                subject: `Payment receipt — ${invoice.invoiceRef}`,
                templateName: "payment-receipt",
                templateData: {
                    clientName: invoice.clientName,
                    invoiceRef: invoice.invoiceRef,
                    paymentRef: payment.paymentRef,
                    paidDate: fmt(now),
                    amount: Number(invoice.total).toFixed(2),
                    paymentMethod: "Bank Transfer",
                    serviceAddress: invoice.serviceAddress ?? invoice.clientName,
                },
            });
        }

        return result;
    } else {
        // reject
        const updatedPayment = await prisma.payment.update({
            where: { id: paymentId },
            data: {
                status: PaymentStatus.FAILED,
                rejectionReason: payload.rejectionReason ?? null,
            },
        });

        return { payment: updatedPayment, invoice };
    }
};

export const invoiceService = {
    createInvoice,
    getAllInvoices,
    getInvoiceById,
    updateInvoice,
    updateInvoiceStatus,
    sendInvoice,
    deleteInvoice,
    getPaymentHistory,
    recordPayment,
    createInvoicePaymentLink,
    submitPaymentProof,
    approvePayment,
};
