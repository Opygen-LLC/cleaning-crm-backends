import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import {
    QuoteStatus,
} from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import {
    IQuoteCreate,
    IQuoteUpdate,
    IQuoteLineItemInput,
    IQuoteConvertToBooking,
} from "./quote.interface";
import { quoteSearchableFields, quoteFilterableFields } from "./quote.constant";
import { IRequestUser } from "../../types/requestUser.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generates a unique quote reference: #OP-QT-0001
 */
const generateQuoteRef = async (): Promise<string> => {
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
const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

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

const quoteInclude = {
    client: {
        select: { id: true, name: true, email: true, phone: true },
    },
    lineItems: true,
    bookings: {
        select: { id: true, bookingRef: true, status: true, scheduledDate: true },
    },
    jobs: {
        select: { id: true, jobRef: true, status: true },
    },
} as const;

// ─── Status transition guard map ──────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
    [QuoteStatus.DRAFT]:    [QuoteStatus.SENT, QuoteStatus.EXPIRED],
    [QuoteStatus.SENT]:     [QuoteStatus.ACCEPTED, QuoteStatus.DECLINED, QuoteStatus.EXPIRED],
    [QuoteStatus.ACCEPTED]: [], // terminal — can only convert to booking
    [QuoteStatus.DECLINED]: [], // terminal
    [QuoteStatus.EXPIRED]:  [], // terminal
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createQuote = async (payload: IQuoteCreate, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

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

    return prisma.quote.create({
        data: {
            quoteRef,
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
                            Math.round(item.quantity * item.unitPrice * 100) / 100,
                    })),
                },
            },
        },
        include: quoteInclude,
    });
};

const getAllQuotes = async (queryParams: IQueryParams, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        include: quoteInclude,
    });

    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    return quote;
};

const updateQuote = async (
    id: string,
    payload: IQuoteUpdate,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

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
    const taxRateToUse   = payload.taxRate ?? Number(existing.taxRate);

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
                ...(payload.serviceType  && { serviceType: payload.serviceType }),
                ...(payload.address      && { address: payload.address }),
                ...(payload.taxRate      !== undefined && { taxRate: payload.taxRate }),
                ...(payload.validUntil   && { validUntil: new Date(payload.validUntil) }),
                ...(payload.notes        !== undefined && { notes: payload.notes }),
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
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        include: { lineItems: true },
    });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    if (quote.status !== QuoteStatus.ACCEPTED) {
        throw new AppError(
            status.BAD_REQUEST,
            `Only ACCEPTED quotes can be converted to bookings. Current status: ${quote.status}`,
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
                // Quote serviceType is a free-text field; cast or default to RESIDENTIAL_CLEAN
                // The frontend should confirm service type when converting
                serviceType: "RESIDENTIAL_CLEAN" as any,
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
                                    select: { id: true, name: true, email: true },
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

/**
 * Allows a client to accept or decline a quote via a public URL reference.
 * The quoteRef is the human-readable ref (e.g. #OP-QT-0001), not the UUID.
 * The frontend at /quote/[ref] calls this endpoint.
 */
const getPublicQuote = async (quoteRef: string) => {
    const quote = await prisma.quote.findUnique({
        where: { quoteRef },
        include: {
            lineItems: true,
            admin: {
                include: {
                    user: { select: { name: true, email: true } },
                },
            },
        },
    });

    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    // Do not expose internal notes or admin IDs to the public
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { internalNotes, adminId, ...safeQuote } = quote;

    return safeQuote;
};

const publicQuoteAction = async (
    quoteRef: string,
    action: "accept" | "decline",
) => {
    const quote = await prisma.quote.findUnique({ where: { quoteRef } });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");

    if (quote.status !== QuoteStatus.SENT) {
        throw new AppError(
            status.BAD_REQUEST,
            `This quote cannot be actioned. Current status: ${quote.status}`,
        );
    }

    // Check validity
    if (new Date() > quote.validUntil) {
        // Auto-expire and reject the action
        await prisma.quote.update({
            where: { quoteRef },
            data: { status: QuoteStatus.EXPIRED },
        });
        throw new AppError(
            status.GONE,
            "This quote has expired and can no longer be accepted.",
        );
    }

    const newStatus =
        action === "accept" ? QuoteStatus.ACCEPTED : QuoteStatus.DECLINED;

    // ── If the client is accepting, auto-create a draft booking ───────────────
    // This removes the need for the admin to manually click "Convert to booking"
    // after a client accepts. The booking is created in SCHEDULED status with
    // the quote's total; the admin sets the date and assigns staff later.
    if (action === "accept") {
        const existingBooking = await prisma.booking.findFirst({
            where: { quoteId: quote.id },
        });

        if (!existingBooking) {
            // Generate booking ref
            const lastBooking = await prisma.booking.findFirst({
                orderBy: { createdAt: "desc" },
                select: { bookingRef: true },
            });
            let nextBk = 1;
            if (lastBooking?.bookingRef) {
                const parts = lastBooking.bookingRef.split("-");
                const num = parseInt(parts[parts.length - 1]);
                if (!isNaN(num)) nextBk = num + 1;
            }
            const bookingRef = `#OP-BK-${nextBk.toString().padStart(4, "0")}`;

            await prisma.$transaction(async (tx) => {
                // Update quote status first
                await tx.quote.update({
                    where: { quoteRef },
                    data: { status: QuoteStatus.ACCEPTED },
                });

                // Create the booking linked to this quote
                await tx.booking.create({
                    data: {
                        bookingRef,
                        adminId:      quote.adminId,
                        clientId:     quote.clientId,
                        serviceType:  "RESIDENTIAL_CLEAN" as any, // Admin can update later
                        address:      quote.address,
                        // scheduledDate defaults to 7 days from now as a placeholder
                        // Admin will update this when they confirm with the client
                        scheduledDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                        durationMins:  120,
                        total:         quote.total,
                        notes:         quote.notes,
                        quoteId:       quote.id,
                    },
                });

                // Update client booking aggregate
                await tx.client.update({
                    where: { id: quote.clientId },
                    data: { totalBookings: { increment: 1 } },
                });
            });

            // Return the updated quote with the new booking included
            const withBooking = await prisma.quote.findUnique({
                where: { quoteRef },
                include: { lineItems: true, bookings: { select: { id: true, bookingRef: true, status: true, scheduledDate: true } } },
            });
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { internalNotes: _n, adminId: _a, ...safeWithBooking } = withBooking!;
            return safeWithBooking;
        }
    }

    const updated = await prisma.quote.update({
        where: { quoteRef },
        data: { status: newStatus },
        include: {
            lineItems: true,
            bookings: { select: { id: true, bookingRef: true, status: true, scheduledDate: true } },
        },
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { internalNotes, adminId, ...safeQuote } = updated;
    return safeQuote;
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
    getPublicQuote,
    publicQuoteAction,
};
