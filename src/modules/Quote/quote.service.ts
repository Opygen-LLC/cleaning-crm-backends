import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import {
    NotificationType,
    QuoteStatus,
} from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import {
    IQuoteCreate,
    IQuoteUpdate,
    IQuoteLineItemInput,
    IQuoteConvertToBooking,
    IQuoteConvertToJob,
} from "./quote.interface";
import { quoteSearchableFields, quoteFilterableFields } from "./quote.constant";
import { IRequestUser } from "../../types/requestUser.interface";
import { randomBytes } from "node:crypto";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { FRONTEND_URL } from "../../config/ENV";
import { createNotification } from "../../lib/utils/createNotification";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PUBLIC_QUOTE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * 32 bytes of cryptographically secure entropy encoded as URL-safe base64.
 * 32 bytes => 256 bits and a 43-character base64url token without padding.
 */
const generatePublicQuoteToken = (): string =>
    randomBytes(32).toString("base64url");

const ensurePublicQuoteToken = async (
    quoteId: string,
    existingToken?: string | null,
): Promise<string> => {
    if (existingToken) return existingToken;

    // A collision is astronomically unlikely, but retrying keeps the helper
    // correct even if the unique index rejects a generated value.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const publicToken = generatePublicQuoteToken();
        try {
            const updated = await prisma.quote.updateMany({
                where: { id: quoteId, publicToken: null },
                data: { publicToken },
            });
            if (updated.count === 1) return publicToken;

            // Another request may have generated the token at the same time.
            // Reuse that value instead of overwriting it and invalidating a
            // secure link already returned to another admin tab.
            const current = await prisma.quote.findUnique({
                where: { id: quoteId },
                select: { publicToken: true },
            });
            if (current?.publicToken) return current.publicToken;
            throw new AppError(status.NOT_FOUND, "Quote not found");
        } catch (error) {
            const prismaCode =
                typeof error === "object" && error !== null && "code" in error
                    ? String((error as { code?: unknown }).code ?? "")
                    : "";
            if (prismaCode === "P2002") continue;
            throw error;
        }
    }

    throw new AppError(
        status.INTERNAL_SERVER_ERROR,
        "Could not create a secure quote link. Please try again.",
        { code: "QUOTE_TOKEN_GENERATION_FAILED", retryable: true },
    );
};

/**
 * Generates a unique quote reference: #OP-QT-0001
 */
export const generateQuoteRef = async (): Promise<string> => {
    const last = await prisma.quote.findFirst({
        orderBy: { createdAt: "desc" },
        select: { quoteRef: true },
    });

    let next = 1;
    if (last?.quoteRef) {
        const parts = last.quoteRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) next = num + 1;
    }

    return `#OP-QT-${next.toString().padStart(4, "0")}`;
};

/**
 * Resolve adminProfile.id from the authenticated user id.
 * Throws 404 when not found.
 */

/**
 * Compute subtotal, tax and total from line items + taxRate.
 * All arithmetic is done in JS numbers and rounded to 2dp for DB storage.
 */
const computeTotals = (
    lineItems: IQuoteLineItemInput[],
    taxRate: number,
): { subtotal: number; tax: number; total: number } => {
    const subtotal = lineItems.reduce(
        (sum, item) =>
            sum + Math.round(item.quantity * item.unitPrice * 100) / 100,
        0,
    );
    const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;

    return { subtotal, tax, total };
};

// ─── Standard includes shared across queries ──────────────────────────────────

export const quoteInclude = {
    client: {
        select: { id: true, name: true, email: true, phone: true },
    },
    lineItems: true,
    bookings: {
        select: {
            id: true,
            bookingRef: true,
            status: true,
            scheduledDate: true,
        },
    },
    jobs: {
        select: { id: true, jobRef: true, status: true },
    },
} as const;

// ─── Status transition guard map ──────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
    [QuoteStatus.DRAFT]: [QuoteStatus.SENT, QuoteStatus.EXPIRED],
    [QuoteStatus.SENT]: [
        QuoteStatus.ACCEPTED,
        QuoteStatus.DECLINED,
        QuoteStatus.EXPIRED,
    ],
    [QuoteStatus.ACCEPTED]: [], // terminal — can only convert to booking
    [QuoteStatus.DECLINED]: [], // terminal
    [QuoteStatus.EXPIRED]: [], // terminal
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createQuote = async (payload: IQuoteCreate, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    // Verify client belongs to this admin
    const client = await prisma.client.findFirst({
        where: { id: payload.clientId, adminId },
    });
    if (!client) throw new AppError(status.NOT_FOUND, "Client not found");

    const quoteRef = await generateQuoteRef();
    const { subtotal, tax, total } = computeTotals(
        payload.lineItems,
        payload.taxRate,
    );

    const quote = await prisma.quote.create({
        data: {
            quoteRef,
            publicToken: generatePublicQuoteToken(),
            adminId,
            clientId: payload.clientId,
            serviceType: payload.serviceType,
            address: payload.address,
            subtotal,
            taxRate: payload.taxRate,
            tax,
            total,
            validUntil: new Date(payload.validUntil),
            notes: payload.notes,
            internalNotes: payload.internalNotes,
            lineItems: {
                createMany: {
                    data: payload.lineItems.map((item) => ({
                        description: item.description,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        total:
                            Math.round(item.quantity * item.unitPrice * 100) /
                            100,
                    })),
                },
            },
        },
        include: quoteInclude,
    });

    // If created from a template, bump its usage counter (non-fatal)
    if (payload.templateId) {
        await recordTemplateUsage(payload.templateId);
    }

    return quote;
};

const getAllQuotes = async (queryParams: IQueryParams, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    return new QueryBuilder(prisma.quote, queryParams, {
        searchableFields: quoteSearchableFields,
        filterableFields: quoteFilterableFields,
    })
        .where({ adminId })
        .search()
        .filter()
        .sort()
        .paginate()
        .include(quoteInclude)
        .execute();
};

const getQuoteById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        include: quoteInclude,
    });

    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    // Existing quotes created before Phase 5 do not have a token yet. Generate
    // one lazily when an authenticated admin opens the detail page so the
    // secure share link is immediately available without a weak DB backfill.
    if (!quote.publicToken) {
        const publicToken = await ensurePublicQuoteToken(quote.id);
        return { ...quote, publicToken };
    }

    return quote;
};

const updateQuote = async (
    id: string,
    payload: IQuoteUpdate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.quote.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Quote not found");

    // Only DRAFT quotes can be edited
    if (existing.status !== QuoteStatus.DRAFT) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot edit a quote with status ${existing.status}. Only DRAFT quotes are editable.`,
        );
    }

    // If line items or taxRate changed, recompute totals
    let totalsUpdate: { subtotal: number; tax: number; total: number } | null =
        null;

    const lineItemsToUse = payload.lineItems;
    const taxRateToUse = payload.taxRate ?? Number(existing.taxRate);

    if (lineItemsToUse) {
        totalsUpdate = computeTotals(lineItemsToUse, taxRateToUse);
    } else if (payload.taxRate !== undefined) {
        // taxRate changed but lineItems stayed the same — re-fetch line items
        const currentLineItems = await prisma.quoteLineItem.findMany({
            where: { quoteId: id },
        });
        const asInput = currentLineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: Number(li.unitPrice),
        }));
        totalsUpdate = computeTotals(asInput, taxRateToUse);
    }

    return prisma.$transaction(async (tx) => {
        // Replace line items when provided
        if (lineItemsToUse) {
            await tx.quoteLineItem.deleteMany({ where: { quoteId: id } });
            await tx.quoteLineItem.createMany({
                data: lineItemsToUse.map((item) => ({
                    quoteId: id,
                    description: item.description,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    total:
                        Math.round(item.quantity * item.unitPrice * 100) / 100,
                })),
            });
        }

        return tx.quote.update({
            where: { id },
            data: {
                ...(payload.serviceType && {
                    serviceType: payload.serviceType,
                }),
                ...(payload.address && { address: payload.address }),
                ...(payload.taxRate !== undefined && {
                    taxRate: payload.taxRate,
                }),
                ...(payload.validUntil && {
                    validUntil: new Date(payload.validUntil),
                }),
                ...(payload.notes !== undefined && { notes: payload.notes }),
                ...(payload.internalNotes !== undefined && {
                    internalNotes: payload.internalNotes,
                }),
                ...(totalsUpdate && totalsUpdate),
            },
            include: quoteInclude,
        });
    });
};

const updateQuoteStatus = async (
    id: string,
    newStatus: QuoteStatus,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.quote.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Quote not found");

    if (!ALLOWED_TRANSITIONS[existing.status].includes(newStatus)) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot transition quote from ${existing.status} to ${newStatus}`,
        );
    }

    const data: Record<string, unknown> = { status: newStatus };

    // Record sentAt timestamp when first sent
    if (newStatus === QuoteStatus.SENT && !existing.sentAt) {
        data.sentAt = new Date();
    }

    return prisma.quote.update({
        where: { id },
        data,
        include: quoteInclude,
    });
};

const deleteQuote = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.quote.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Quote not found");

    // Prevent deletion of accepted quotes that may already have bookings
    if (existing.status === QuoteStatus.ACCEPTED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot delete an accepted quote. Archive or cancel the linked booking instead.",
        );
    }

    // Cascade delete (line items, etc.) is handled by Prisma onDelete: Cascade
    await prisma.quote.delete({ where: { id } });
};

// ─── Convert accepted quote → booking ────────────────────────────────────────

/**
 * Creates a Booking directly from an ACCEPTED Quote.
 * The booking inherits client, address, and total from the quote.
 */
const convertQuoteToBooking = async (
    id: string,
    payload: IQuoteConvertToBooking,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        include: {
            lineItems: true,
            bookings: { select: { id: true, bookingRef: true } },
        },
    });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    if (quote.status !== QuoteStatus.ACCEPTED) {
        throw new AppError(
            status.BAD_REQUEST,
            `Only ACCEPTED quotes can be converted to bookings. Current status: ${quote.status}`,
        );
    }

    if (quote.bookings.length > 0) {
        throw new AppError(
            status.CONFLICT,
            `This quote is already linked to booking ${quote.bookings[0].bookingRef}.`,
            { code: "QUOTE_ALREADY_CONVERTED_TO_BOOKING", retryable: false },
        );
    }

    // Validate staff IDs if provided
    if (payload.staffIds?.length) {
        const staffCount = await prisma.staffProfile.count({
            where: { id: { in: payload.staffIds }, adminId },
        });
        if (staffCount !== payload.staffIds.length) {
            throw new AppError(
                status.BAD_REQUEST,
                "One or more staff members not found",
            );
        }
    }

    // Generate booking ref
    const last = await prisma.booking.findFirst({
        orderBy: { createdAt: "desc" },
        select: { bookingRef: true },
    });
    let nextBk = 1;
    if (last?.bookingRef) {
        const parts = last.bookingRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) nextBk = num + 1;
    }
    const bookingRef = `#OP-BK-${nextBk.toString().padStart(4, "0")}`;

    return prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({
            data: {
                bookingRef,
                adminId,
                clientId: quote.clientId,
                // Quote serviceType is free text, so the admin explicitly
                // confirms the Booking ServiceType during conversion.
                serviceType: payload.serviceType,
                address: quote.address,
                scheduledDate: new Date(payload.scheduledDate),
                durationMins: payload.durationMins,
                total: quote.total,
                notes: payload.notes ?? quote.notes,
                quoteId: quote.id,
                ...(payload.staffIds?.length && {
                    staffAssignments: {
                        createMany: {
                            data: payload.staffIds.map((staffId) => ({
                                staffId,
                            })),
                        },
                    },
                }),
            },
            include: {
                client: {
                    select: { id: true, name: true, email: true, phone: true },
                },
                staffAssignments: {
                    include: {
                        staff: {
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        name: true,
                                        email: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        // Update client aggregates
        await tx.client.update({
            where: { id: quote.clientId },
            data: {
                totalBookings: { increment: 1 },
                lastBookingDate: new Date(payload.scheduledDate),
            },
        });

        return booking;
    });
};

// ─── Public unauthenticated endpoint ─────────────────────────────────────────

const publicQuoteSelect = {
    id: true,
    quoteRef: true,
    status: true,
    serviceType: true,
    address: true,
    subtotal: true,
    taxRate: true,
    tax: true,
    total: true,
    validUntil: true,
    notes: true,
    sentAt: true,
    respondedAt: true,
    responseNote: true,
    createdAt: true,
    lineItems: {
        select: {
            id: true,
            description: true,
            quantity: true,
            unitPrice: true,
            total: true,
        },
    },
    admin: {
        select: {
            businessName: true,
            businessEmail: true,
            businessLogo: true,
            brandColor: true,
        },
    },
} as const;

const publicQuoteNotFound = () =>
    new AppError(status.NOT_FOUND, "Quote not found", {
        code: "QUOTE_NOT_FOUND",
        retryable: false,
    });

const quoteExpiredError = () =>
    new AppError(
        status.GONE,
        "This quote has expired and can no longer be accepted.",
        { code: "QUOTE_EXPIRED", retryable: false },
    );

const getPublicQuote = async (publicToken: string) => {
    // Reject obviously invalid values before hitting the database. Return 404
    // rather than validation details so the endpoint does not reveal token
    // format or quote existence information.
    if (!PUBLIC_QUOTE_TOKEN_RE.test(publicToken)) {
        throw publicQuoteNotFound();
    }

    let quote = await prisma.quote.findUnique({
        where: { publicToken },
        select: publicQuoteSelect,
    });

    // Draft quotes have never been intentionally shared with a client.
    if (!quote || quote.status === QuoteStatus.DRAFT) {
        throw publicQuoteNotFound();
    }

    // Expire stale SENT quotes on read so the public page renders the correct
    // terminal state even if a background expiry job has not run yet.
    if (quote.status === QuoteStatus.SENT && new Date() > quote.validUntil) {
        await prisma.quote.updateMany({
            where: { id: quote.id, status: QuoteStatus.SENT },
            data: { status: QuoteStatus.EXPIRED },
        });
        quote = { ...quote, status: QuoteStatus.EXPIRED };
    }

    return quote;
};

const publicQuoteAction = async (
    publicToken: string,
    action: "accept" | "decline",
    note?: string,
) => {
    if (!PUBLIC_QUOTE_TOKEN_RE.test(publicToken)) {
        throw publicQuoteNotFound();
    }

    const quote = await prisma.quote.findUnique({
        where: { publicToken },
        select: {
            id: true,
            quoteRef: true,
            adminId: true,
            status: true,
            validUntil: true,
        },
    });

    if (!quote || quote.status === QuoteStatus.DRAFT) {
        throw publicQuoteNotFound();
    }

    const newStatus =
        action === "accept" ? QuoteStatus.ACCEPTED : QuoteStatus.DECLINED;

    // Idempotency: retries/double-clicks of the same action return the current
    // quote instead of surfacing a false error or creating duplicate work.
    if (quote.status === newStatus) {
        return getPublicQuote(publicToken);
    }

    if (
        quote.status === QuoteStatus.ACCEPTED ||
        quote.status === QuoteStatus.DECLINED
    ) {
        throw new AppError(
            status.CONFLICT,
            `This quote has already been ${quote.status.toLowerCase()}.`,
            { code: "QUOTE_ALREADY_RESPONDED", retryable: false },
        );
    }

    const now = new Date();
    if (quote.status === QuoteStatus.EXPIRED || now > quote.validUntil) {
        if (quote.status === QuoteStatus.SENT) {
            await prisma.quote.updateMany({
                where: { id: quote.id, status: QuoteStatus.SENT },
                data: { status: QuoteStatus.EXPIRED },
            });
        }
        throw quoteExpiredError();
    }

    if (quote.status !== QuoteStatus.SENT) {
        throw new AppError(
            status.CONFLICT,
            "This quote is no longer awaiting a client response.",
            { code: "QUOTE_NOT_ACTIONABLE", retryable: false },
        );
    }

    const cleanNote = note?.trim() || null;

    // Atomic compare-and-set. If accept and decline are submitted at the same
    // time, exactly one transition from SENT can win. The loser reads the final
    // state below and receives either idempotent success or a clear conflict.
    const transition = await prisma.quote.updateMany({
        where: {
            id: quote.id,
            status: QuoteStatus.SENT,
            validUntil: { gte: now },
        },
        data: {
            status: newStatus,
            respondedAt: now,
            responseNote: action === "decline" ? cleanNote : null,
        },
    });

    if (transition.count === 0) {
        const current = await prisma.quote.findUnique({
            where: { id: quote.id },
            select: { status: true, validUntil: true },
        });

        if (!current) throw publicQuoteNotFound();
        if (current.status === newStatus) return getPublicQuote(publicToken);
        if (
            current.status === QuoteStatus.EXPIRED ||
            now > current.validUntil
        ) {
            throw quoteExpiredError();
        }

        throw new AppError(
            status.CONFLICT,
            `This quote has already been ${current.status.toLowerCase()}.`,
            { code: "QUOTE_ALREADY_RESPONDED", retryable: false },
        );
    }

    // Accepting a quote deliberately DOES NOT create a placeholder booking.
    // Scheduling requires a real service type, date and duration chosen by the
    // admin. The accepted quote is the pending work item until that happens.
    createNotification({
        adminId: quote.adminId,
        type: NotificationType.QUOTE,
        title: `Quote ${quote.quoteRef} ${action === "accept" ? "accepted" : "declined"}`,
        message:
            action === "accept"
                ? "Client accepted the quote — schedule the booking when the date and time are confirmed"
                : cleanNote
                  ? `Client declined the quote: ${cleanNote}`
                  : "Client declined the quote",
        relatedId: quote.id,
    }).catch(() => {});

    return getPublicQuote(publicToken);
};

// ─── Send quote email ─────────────────────────────────────────────────────────

const sendQuoteEmail = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        include: {
            client: {
                select: { id: true, name: true, email: true, phone: true },
            },
            admin: {
                select: { businessName: true, businessEmail: true },
            },
            lineItems: true,
        },
    });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    if (!quote.client.email) {
        throw new AppError(
            status.BAD_REQUEST,
            "Client has no email address on file",
        );
    }

    if (
        quote.status === QuoteStatus.ACCEPTED ||
        quote.status === QuoteStatus.DECLINED ||
        quote.status === QuoteStatus.EXPIRED
    ) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot send a quote that is ${quote.status.toLowerCase()}`,
        );
    }

    const fmt = (d: Date) =>
        d.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
        });
    const fmt2dp = (n: unknown) => Number(n).toFixed(2);

    const publicToken = await ensurePublicQuoteToken(
        quote.id,
        quote.publicToken,
    );

    const quoteViewUrl = FRONTEND_URL
        ? `${FRONTEND_URL}/quote/${encodeURIComponent(publicToken)}`
        : null;

    await sendEmailSafely({
        adminId,
        to: quote.client.email,
        subject: `Quote ${quote.quoteRef} from ${quote.admin.businessName} — valid until ${fmt(quote.validUntil)}`,
        templateName: "quote-send",
        templateData: {
            quoteRef: quote.quoteRef,
            businessName: quote.admin.businessName,
            clientName: quote.client.name,
            serviceType: quote.serviceType,
            address: quote.address,
            lineItems: quote.lineItems.map((li) => ({
                description: li.description,
                quantity: li.quantity,
                total: fmt2dp(li.total),
            })),
            subtotal: fmt2dp(quote.subtotal),
            taxRate: Number(quote.taxRate),
            tax: fmt2dp(quote.tax),
            total: fmt2dp(quote.total),
            validUntil: fmt(quote.validUntil),
            notes: quote.notes ?? null,
            quoteViewUrl,
        },
    });

    // Stamp sentAt and advance DRAFT → SENT
    const updated = await prisma.quote.update({
        where: { id },
        data: {
            sentAt: new Date(),
            status:
                quote.status === QuoteStatus.DRAFT
                    ? QuoteStatus.SENT
                    : quote.status,
        },
        include: quoteInclude,
    });

    return updated;
};

// ─── Quote Templates ──────────────────────────────────────────────────────────

export interface IQuoteTemplateLineItemInput {
    description: string;
    quantity: number;
    unitPrice: number;
}

export interface IQuoteTemplateCreate {
    name: string;
    serviceType: string;
    taxRate?: number;
    notes?: string;
    lineItems: IQuoteTemplateLineItemInput[];
}

export interface IQuoteTemplateUpdate {
    name?: string;
    serviceType?: string;
    taxRate?: number;
    notes?: string;
    lineItems?: IQuoteTemplateLineItemInput[];
}

const templateInclude = {
    lineItems: true,
} as const;

const getAllQuoteTemplates = async (user: IRequestUser) => {
    const adminId = await getAdminId(user);
    return prisma.quoteTemplate.findMany({
        where: { adminId },
        include: templateInclude,
        orderBy: { usageCount: "desc" },
    });
};

const createQuoteTemplate = async (
    payload: IQuoteTemplateCreate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    return prisma.quoteTemplate.create({
        data: {
            adminId,
            name: payload.name,
            serviceType: payload.serviceType,
            taxRate: payload.taxRate ?? 20,
            notes: payload.notes,
            lineItems: {
                createMany: {
                    data: payload.lineItems.map((li) => ({
                        description: li.description,
                        quantity: li.quantity,
                        unitPrice: li.unitPrice,
                    })),
                },
            },
        },
        include: templateInclude,
    });
};

const updateQuoteTemplate = async (
    id: string,
    payload: IQuoteTemplateUpdate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.quoteTemplate.findFirst({
        where: { id, adminId },
    });
    if (!existing)
        throw new AppError(status.NOT_FOUND, "Quote template not found");

    return prisma.$transaction(async (tx) => {
        if (payload.lineItems) {
            await tx.quoteTemplateLineItem.deleteMany({
                where: { templateId: id },
            });
            await tx.quoteTemplateLineItem.createMany({
                data: payload.lineItems.map((li) => ({
                    templateId: id,
                    description: li.description,
                    quantity: li.quantity,
                    unitPrice: li.unitPrice,
                })),
            });
        }

        return tx.quoteTemplate.update({
            where: { id },
            data: {
                ...(payload.name && { name: payload.name }),
                ...(payload.serviceType && {
                    serviceType: payload.serviceType,
                }),
                ...(payload.taxRate !== undefined && {
                    taxRate: payload.taxRate,
                }),
                ...(payload.notes !== undefined && { notes: payload.notes }),
            },
            include: templateInclude,
        });
    });
};

const deleteQuoteTemplate = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.quoteTemplate.findFirst({
        where: { id, adminId },
    });
    if (!existing)
        throw new AppError(status.NOT_FOUND, "Quote template not found");

    await prisma.quoteTemplate.delete({ where: { id } });
};

/**
 * Increment usageCount and stamp lastUsedAt when a template is used to
 * pre-fill a new quote. Called from createQuote when templateId is supplied.
 */
const recordTemplateUsage = async (templateId: string) => {
    await prisma.quoteTemplate
        .update({
            where: { id: templateId },
            data: {
                usageCount: { increment: 1 },
                lastUsedAt: new Date(),
            },
        })
        .catch(() => {
            /* non-fatal */
        });
};

// ─── Convert accepted quote → job ─────────────────────────────────────────────

/**
 * Creates a Job directly from an ACCEPTED Quote.
 * The job inherits client, address, service type, and notes from the quote.
 * A unique jobRef is generated; geocoding fires in the background.
 */
const convertQuoteToJob = async (
    id: string,
    payload: IQuoteConvertToJob,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        include: { lineItems: true, client: { select: { id: true } } },
    });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    if (quote.status !== QuoteStatus.ACCEPTED) {
        throw new AppError(
            status.BAD_REQUEST,
            `Only ACCEPTED quotes can be converted to jobs. Current status: ${quote.status}`,
        );
    }

    if (payload.staffIds?.length) {
        const staffCount = await prisma.staffProfile.count({
            where: { id: { in: payload.staffIds }, adminId },
        });
        if (staffCount !== payload.staffIds.length) {
            throw new AppError(
                status.BAD_REQUEST,
                "One or more staff members not found",
            );
        }
    }

    // Generate job ref
    const lastJob = await prisma.job.findFirst({
        where: { adminId },
        orderBy: { createdAt: "desc" },
        select: { jobRef: true },
    });
    let nextNum = 1;
    if (lastJob?.jobRef) {
        const parts = lastJob.jobRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) nextNum = num + 1;
    }
    const jobRef = `#OP-JB-${nextNum.toString().padStart(4, "0")}`;

    // Map quote serviceType (free text) to nearest ServiceType enum value
    const { ServiceType } = await import("../../generated/prisma/enums");
    const serviceTypeMap: Record<string, string> = {
        "Residential Clean":  ServiceType.RESIDENTIAL_CLEAN,
        "Deep Clean":         ServiceType.DEEP_CLEAN,
        "Office Clean":       ServiceType.OFFICE_CLEAN,
        "End of Tenancy":     ServiceType.END_OF_TENANCY,
        "Carpet Clean":       ServiceType.CARPET_CLEAN,
        "Window Clean":       ServiceType.WINDOW_CLEAN,
        "Move-In/Out Clean":  ServiceType.MOVE_IN_OUT_CLEAN,
    };
    const resolvedServiceType =
        (serviceTypeMap[quote.serviceType] as any) ??
        ServiceType.RESIDENTIAL_CLEAN;

    const job = await prisma.$transaction(async (tx) => {
        const created = await tx.job.create({
            data: {
                jobRef,
                adminId,
                clientId: quote.clientId,
                serviceType: resolvedServiceType,
                address: quote.address,
                scheduledDate: new Date(payload.scheduledDate),
                durationMins: payload.durationMins,
                notes: payload.notes ?? quote.notes ?? undefined,
                quoteId: quote.id,
                ...(payload.staffIds?.length && {
                    staffAssignments: {
                        createMany: {
                            data: payload.staffIds.map((staffId) => ({ staffId })),
                        },
                    },
                }),
            },
            include: {
                client: { select: { id: true, name: true, email: true, phone: true } },
                staffAssignments: {
                    include: {
                        staff: {
                            include: {
                                user: { select: { id: true, name: true, email: true } },
                            },
                        },
                    },
                },
            },
        });
        return created;
    });

    return job;
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const quoteService = {
    createQuote,
    getAllQuotes,
    getQuoteById,
    updateQuote,
    updateQuoteStatus,
    deleteQuote,
    convertQuoteToBooking,
    convertQuoteToJob,
    getPublicQuote,
    publicQuoteAction,
    sendQuoteEmail,
    getAllQuoteTemplates,
    createQuoteTemplate,
    updateQuoteTemplate,
    deleteQuoteTemplate,
    recordTemplateUsage,
};
