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
import { uploadFileToCloudinary } from "../../config/cloudinary";
import { createNotification } from "../../lib/utils/createNotification";
import { NotificationType } from "../../generated/prisma/enums";
import { FRONTEND_URL } from "../../config/ENV";
import { logActivity } from "../../lib/utils/logActivity";

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

    const invoice = await prisma.invoice.create({
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

    logActivity({
        adminId: adminProfile.id,
        action: "CREATE_INVOICE",
        entityType: "Invoice",
        entityId: invoice.id,
        description: `Created invoice ${invoice.invoiceRef} for ${invoice.clientName} (${invoice.total})`,
    });

    return invoice;
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

    const updated = await prisma.invoice.update({
        where: { id },
        data,
    });

    // Notify admin when an invoice is manually marked PAID
    if (invoiceStatus === InvoiceStatus.PAID) {
        createNotification({
            adminId: updated.adminId,
            type: NotificationType.PAYMENT,
            title: `Invoice ${updated.invoiceRef} paid`,
            message: `Payment received from ${updated.clientName}`,
            relatedId: updated.id,
        }).catch(() => {});
    }

    logActivity({
        adminId: updated.adminId,
        action: `INVOICE_STATUS_${invoiceStatus}`,
        entityType: "Invoice",
        entityId: updated.id,
        description: `Invoice ${updated.invoiceRef} status changed to ${invoiceStatus}`,
    });

    return updated;
};

const deleteInvoice = async (id: string) => {
    const invoice = await prisma.invoice.findUnique({ where: { id } });

    if (!invoice) {
        throw new AppError(status.NOT_FOUND, "Invoice not found");
    }

    const deleted = await prisma.invoice.delete({
        where: { id },
    });

    logActivity({
        adminId: invoice.adminId,
        action: "DELETE_INVOICE",
        entityType: "Invoice",
        entityId: invoice.id,
        description: `Deleted invoice ${invoice.invoiceRef}`,
    });

    return deleted;
};

// ── Payment History ───────────────────────────────────────────────────────────

interface IPaymentHistoryFilters {
    page?: number;
    limit?: number;
    searchTerm?: string;
    method?: string; // display label: "Cash", "Bank Transfer", "Cheque", "Manual", or "All"
    adminId?: string;
}

// ── Payment method label <-> enum mapping ────────────────────────────────────
// The DB stores PaymentMethod as an enum (BANK_TRANSFER, CASH, CHEQUE, MANUAL);
// the frontend works with display labels ("Bank Transfer", "Cash", ...).
const METHOD_LABELS: Record<PaymentMethod, string> = {
    [PaymentMethod.BANK_TRANSFER]: "Bank Transfer",
    [PaymentMethod.CASH]: "Cash",
    [PaymentMethod.CHEQUE]: "Cheque",
    [PaymentMethod.MANUAL]: "Manual",
};

const LABEL_TO_METHOD: Record<string, PaymentMethod> = Object.entries(
    METHOD_LABELS,
).reduce(
    (acc, [enumVal, label]) => {
        acc[label] = enumVal as PaymentMethod;
        return acc;
    },
    {} as Record<string, PaymentMethod>,
);

/**
 * Payment history is derived from the Payment table (the source of truth for
 * both manually recorded payments and manual bank-transfer proofs awaiting
 * approval). Includes PAID payments (settled) and PENDING_APPROVAL payments
 * (awaiting admin review) so the frontend can split them into tabs.
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

    // ── Build filter for the list (PAID + PENDING_APPROVAL payments) ───────────
    const andConditions: any[] = [
        {
            status: {
                in: [PaymentStatus.PAID, PaymentStatus.PENDING_APPROVAL],
            },
        },
    ];

    if (resolvedAdminId) {
        andConditions.push({ adminId: resolvedAdminId });
    }

    if (searchTerm) {
        andConditions.push({
            OR: [
                { paymentRef: { contains: searchTerm, mode: "insensitive" } },
                {
                    transactionId: {
                        contains: searchTerm,
                        mode: "insensitive",
                    },
                },
                {
                    invoice: {
                        is: {
                            OR: [
                                {
                                    invoiceRef: {
                                        contains: searchTerm,
                                        mode: "insensitive",
                                    },
                                },
                                {
                                    clientName: {
                                        contains: searchTerm,
                                        mode: "insensitive",
                                    },
                                },
                                {
                                    clientEmail: {
                                        contains: searchTerm,
                                        mode: "insensitive",
                                    },
                                },
                            ],
                        },
                    },
                },
            ],
        });
    }

    if (method && method !== "All" && LABEL_TO_METHOD[method]) {
        andConditions.push({ method: LABEL_TO_METHOD[method] });
    }

    const [paymentRows, total] = await Promise.all([
        prisma.payment.findMany({
            where: { AND: andConditions },
            orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
            skip: (page - 1) * limit,
            take: limit,
            include: {
                invoice: {
                    select: { invoiceRef: true, clientName: true },
                },
            },
        }),
        prisma.payment.count({ where: { AND: andConditions } }),
    ]);

    // ── Stats (across all *settled* (PAID) payments for this admin) ────────────
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const settledWhere: any = { status: PaymentStatus.PAID };
    if (resolvedAdminId) settledWhere.adminId = resolvedAdminId;

    const [allSettled, thisMonthSettled] = await Promise.all([
        prisma.payment.findMany({
            where: settledWhere,
            select: { amount: true, method: true, paidAt: true },
        }),
        prisma.payment.findMany({
            where: { ...settledWhere, paidAt: { gte: startOfThisMonth } },
            select: { amount: true },
        }),
    ]);

    const totalCollected = allSettled.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
    );
    const thisMonth = thisMonthSettled.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
    );
    const avgPayment =
        allSettled.length > 0
            ? Math.round(totalCollected / allSettled.length)
            : 0;

    // ── Payment method breakdown, computed from real settled payments ──────────
    const byMethodMap = new Map<string, { amount: number; count: number }>();
    for (const label of Object.values(METHOD_LABELS)) {
        byMethodMap.set(label, { amount: 0, count: 0 });
    }
    for (const p of allSettled) {
        const label = METHOD_LABELS[p.method] ?? p.method;
        const bucket = byMethodMap.get(label) ?? { amount: 0, count: 0 };
        bucket.amount += Number(p.amount);
        bucket.count += 1;
        byMethodMap.set(label, bucket);
    }
    const byMethod = Array.from(byMethodMap.entries()).map(
        ([methodLabel, v]) => ({
            method: methodLabel,
            amount: v.amount,
            count: v.count,
        }),
    );

    // ── Shape payments list ───────────────────────────────────────────────────
    const payments = paymentRows.map((p) => {
        const displayDate = p.paidAt ?? p.createdAt;
        return {
            id: p.id,
            paymentRef: p.paymentRef,
            invoiceRef: p.invoice?.invoiceRef ?? "",
            clientName: p.invoice?.clientName ?? "",
            clientAvatar: undefined,
            amount: Number(p.amount),
            method: METHOD_LABELS[p.method] ?? p.method,
            status: p.status,
            paymentProofUrl: p.paymentProofUrl ?? undefined,
            rejectionReason: p.rejectionReason ?? undefined,
            notes: p.note ?? undefined,
            date: new Date(displayDate).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
            }),
        };
    });

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

    const result = await prisma.$transaction(async (tx) => {
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

        // Sum all PAID payments for this invoice (including the one just created)
        const aggregate = await tx.payment.aggregate({
            where: { invoiceId: invoice.id, status: PaymentStatus.PAID },
            _sum: { amount: true },
        });
        const totalPaid = Number(aggregate._sum.amount ?? 0);
        const invoiceTotal = Number(invoice.total);
        const shouldMarkPaid = totalPaid >= invoiceTotal;

        // Mark invoice as PAID only when fully covered
        const updatedInvoice = await tx.invoice.update({
            where: { id: invoiceId },
            data: {
                ...(shouldMarkPaid
                    ? { status: InvoiceStatus.PAID, paidDate: paidAt }
                    : { status: InvoiceStatus.SENT }),
            },
        });

        return { payment, invoice: updatedInvoice };
    });

    // Notify admin — different message depending on whether invoice is now fully paid
    const isNowPaid = result.invoice.status === InvoiceStatus.PAID;
    createNotification({
        adminId: admin.id,
        type: NotificationType.PAYMENT,
        title: isNowPaid
            ? `Invoice ${invoice.invoiceRef} fully paid`
            : `Payment recorded on ${invoice.invoiceRef}`,
        message: isNowPaid
            ? `All payments received — invoice marked as PAID`
            : `${payload.method} payment of £${Number(payload.amount).toFixed(2)} recorded (partial)`,
        relatedId: invoice.id,
    }).catch(() => {});

    logActivity({
        adminId: admin.id,
        action: "RECORD_PAYMENT",
        entityType: "Invoice",
        entityId: invoice.id,
        description: `Recorded ${payload.method} payment of ${payload.amount} on invoice ${invoice.invoiceRef}`,
    });

    return result;
};

// ── Submit payment proof (bank-transfer screenshot) ──────────────────────────
//
// Called by admin (or on behalf of client).
// Uploads the proof image to Cloudinary, creates or updates a Payment record
// with status PENDING_APPROVAL, and keeps the invoice in its current state
// until an admin approves.

interface ISubmitPaymentProofAuthCtx {
    user?: { id: string } | undefined;
    portalClient?: { id: string; adminId: string } | undefined;
}

const submitPaymentProof = async (
    invoiceId: string,
    paymentId: string,
    file: Express.Multer.File,
    authCtx: ISubmitPaymentProofAuthCtx,
) => {
    // Two callers hit this route: an authenticated admin submitting proof on
    // a client's behalf, or the client themselves via their portal token.
    // Either way we resolve to an `adminId` that scopes the invoice lookup —
    // for the portal path that also doubles as the ownership check (the
    // invoice must belong to a booking for *this* client).
    let adminId: string;
    let invoice: Awaited<ReturnType<typeof prisma.invoice.findFirst>>;

    if (authCtx.portalClient) {
        invoice = await prisma.invoice.findFirst({
            where: {
                id: invoiceId,
                booking: { clientId: authCtx.portalClient.id },
            },
        });
        if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");
        adminId = authCtx.portalClient.adminId;
    } else {
        if (!authCtx.user) {
            throw new AppError(status.UNAUTHORIZED, "Unauthorized");
        }
        const admin = await prisma.adminProfile.findUnique({
            where: { userId: authCtx.user.id },
        });
        if (!admin)
            throw new AppError(status.NOT_FOUND, "Admin profile not found");

        invoice = await prisma.invoice.findFirst({
            where: { id: invoiceId, adminId: admin.id },
        });
        if (!invoice) throw new AppError(status.NOT_FOUND, "Invoice not found");
        adminId = admin.id;
    }

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
                adminId,
                invoiceId: invoice.id,
            },
        });
    } else {
        // Update an existing payment record
        const existing = await prisma.payment.findFirst({
            where: { id: paymentId, adminId },
        });
        if (!existing)
            throw new AppError(status.NOT_FOUND, "Payment not found");

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

        // Notify admin of approval
        createNotification({
            adminId: admin.id,
            type: NotificationType.PAYMENT,
            title: `Invoice ${invoice.invoiceRef} paid`,
            message: "Manual payment proof approved — invoice marked as paid",
            relatedId: invoice.id,
        }).catch(() => {});

        logActivity({
            adminId: admin.id,
            action: "APPROVE_PAYMENT_PROOF",
            entityType: "Invoice",
            entityId: invoice.id,
            description: `Approved payment proof on invoice ${invoice.invoiceRef}`,
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
                    serviceAddress:
                        invoice.serviceAddress ?? invoice.clientName,
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

        logActivity({
            adminId: admin.id,
            action: "REJECT_PAYMENT_PROOF",
            entityType: "Invoice",
            entityId: invoice.id,
            description: `Rejected payment proof on invoice ${invoice.invoiceRef}${
                payload.rejectionReason ? `: ${payload.rejectionReason}` : ""
            }`,
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
    submitPaymentProof,
    approvePayment,
};
