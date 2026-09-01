import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { requireE164Phone } from "../../lib/validation/phone";
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
import { createNotification } from "../../lib/utils/createNotification";
import { nextReference } from "../../lib/utils/referenceNumber";
import { inferLegacyServiceType, resolveFlexibleServiceIdentity, serviceDisplayName } from "../../lib/utils/serviceIdentity";
import { assertWithinLimit } from "../../lib/utils/checkPlanLimits";
import { queueQuoteSentNotificationTx } from "../../lib/notifications/businessNotificationEvents";
import { PublicDocumentLinkService } from "../Website/publicDocumentLink.service";
import { PublicDocumentPublicationService } from "../Website/publicDocumentPublication.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isPublicUrlConfigurationError = (error: unknown): boolean =>
    error instanceof AppError &&
    [
        "WEBSITE_REQUIRED_FOR_PUBLIC_LINK",
        "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE",
    ].includes(error.code ?? "");

const resolveQuoteShareUrlIfAvailable = async (
    adminId: string,
    publicToken: string | null,
): Promise<string | null> => {
    if (!publicToken) return null;
    try {
        return await PublicDocumentLinkService.buildPublicDocumentUrl({
            adminId,
            resourceType: "quote",
            token: publicToken,
        });
    } catch (error) {
        if (isPublicUrlConfigurationError(error)) return null;
        throw error;
    }
};

const withQuoteShareUrl = async <T extends {
    publicToken: string | null;
    status: QuoteStatus;
    publishedAt: Date | null;
}>(
    adminId: string,
    quote: T,
): Promise<T & { shareUrl: string | null }> => ({
    ...quote,
    shareUrl:
        quote.status === QuoteStatus.DRAFT || !quote.publishedAt
            ? null
            : await resolveQuoteShareUrlIfAvailable(adminId, quote.publicToken),
});

const resolveWebsiteAdminIdForPublicQuote = async (
    websiteId?: string,
): Promise<string | null> => {
    try {
        return await PublicDocumentLinkService.resolveWebsiteAdminId(websiteId);
    } catch {
        throw publicQuoteNotFound();
    }
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

export const quoteInclude = {
    client: {
        select: { id: true, name: true, email: true, phone: true },
    },
    lineItems: true,
    serviceCatalog: {
        select: { id: true, serviceName: true, basePrice: true, duration: true, legacyServiceType: true },
    },
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

const resolveOrCreateClient = async (
    adminId: string,
    payload: IQuoteCreate,
): Promise<string> => {
    if (payload.clientId) {
        const client = await prisma.client.findFirst({
            where: { id: payload.clientId, adminId },
        });
        if (!client) throw new AppError(status.NOT_FOUND, "Client not found");
        return client.id;
    }

    if (!payload.clientEmail || !payload.clientName) {
        throw new AppError(
            status.BAD_REQUEST,
            "Provide either clientId, or clientName and clientEmail to create a new client",
        );
    }

    const email = payload.clientEmail.trim().toLowerCase();

    const existing = await prisma.client.findUnique({
        where: { email_adminId: { email, adminId } },
    });
    if (existing) return existing.id;

    // Brand-new client — enforce plan limits before inserting.
    await assertWithinLimit(adminId, "client");

    const created = await prisma.client.create({
        data: {
            adminId,
            name: payload.clientName.trim(),
            email,
            phone: payload.clientPhone
                ? requireE164Phone(payload.clientPhone, "clientPhone")
                : "",
            addressLine1: payload.address,
            city: "",
            zipcode: "",
            country: "",
        },
    });

    return created.id;
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createQuote = async (payload: IQuoteCreate, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    // Preflight publication before any client-side effects. A PUBLISH/SEND request must
    // have a resolvable tenant website before we create or reuse CRM data.
    const publication = await PublicDocumentPublicationService.prepareCreation({
        adminId,
        resourceType: "quote",
        deliveryIntent: payload.deliveryIntent,
    });

    const [resolvedClientId, serviceIdentity] = await Promise.all([
        resolveOrCreateClient(adminId, payload),
        resolveFlexibleServiceIdentity(adminId, {
            serviceCatalogId: payload.serviceCatalogId,
            serviceType: payload.serviceType,
        }),
    ]);

    const { subtotal, tax, total } = computeTotals(payload.lineItems, payload.taxRate);

    const quote = await prisma.$transaction(async (tx) => {
        if (payload.deliveryIntent === "SEND") {
            const client = await tx.client.findFirst({
                where: { id: resolvedClientId, adminId },
                select: { email: true },
            });
            if (!client?.email) {
                throw new AppError(status.BAD_REQUEST, "Client has no email address on file", {
                    code: "QUOTE_CLIENT_EMAIL_REQUIRED",
                    retryable: false,
                });
            }
        }

        const quoteRef = await nextReference(tx, "quote");
        const created = await tx.quote.create({
            data: {
                quoteRef,
                publicToken: publication.publicToken,
                status: publication.status,
                publishedAt: publication.publishedAt,
                sentAt: publication.sentAt,
                adminId,
                clientId: resolvedClientId,
                serviceCatalogId: serviceIdentity.serviceCatalogId,
                serviceType: serviceIdentity.serviceType,
                serviceNameSnapshot: serviceIdentity.serviceNameSnapshot,
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
                            total: Math.round(item.quantity * item.unitPrice * 100) / 100,
                        })),
                    },
                },
            },
            include: quoteInclude,
        });

        if (payload.deliveryIntent === "SEND" && publication.sentAt && publication.shareUrl) {
            await queueQuoteSentNotificationTx(
                tx,
                created.id,
                publication.sentAt.toISOString(),
                publication.shareUrl,
            );
        }

        return created;
    });

    if (payload.templateId) await recordTemplateUsage(payload.templateId);
    return { ...quote, shareUrl: publication.shareUrl };
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

    return withQuoteShareUrl(adminId, quote);
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

    const serviceIdentity =
        payload.serviceCatalogId !== undefined || payload.serviceType !== undefined
            ? await resolveFlexibleServiceIdentity(adminId, {
                  serviceCatalogId: payload.serviceCatalogId ?? undefined,
                  serviceType: payload.serviceType,
              })
            : null;

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
                ...(serviceIdentity && {
                    serviceCatalogId: serviceIdentity.serviceCatalogId,
                    serviceType: serviceIdentity.serviceType,
                    serviceNameSnapshot: serviceIdentity.serviceNameSnapshot,
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

    // Legacy/status-only callers that set SENT now go through the same
    // publication lifecycle as explicit Publish. This guarantees a token,
    // publishedAt timestamp and canonical tenant URL before the state changes.
    if (newStatus === QuoteStatus.SENT) {
        const publication = await PublicDocumentPublicationService.publishQuote({
            id,
            adminId,
            intent: "PUBLISH",
        });
        const updated = await prisma.quote.findFirst({ where: { id, adminId }, include: quoteInclude });
        if (!updated) throw new AppError(status.NOT_FOUND, "Quote not found");
        return { ...updated, shareUrl: publication.shareUrl };
    }

    const existing = await prisma.quote.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Quote not found");

    if (!ALLOWED_TRANSITIONS[existing.status].includes(newStatus)) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot transition quote from ${existing.status} to ${newStatus}`,
        );
    }

    const updated = await prisma.quote.update({
        where: { id },
        data: { status: newStatus },
        include: quoteInclude,
    });
    return withQuoteShareUrl(adminId, updated);
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
            serviceCatalog: { select: { id: true, serviceName: true, basePrice: true, duration: true, legacyServiceType: true } },
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


    return prisma.$transaction(async (tx) => {
        const bookingRef = await nextReference(tx, "booking");
        const legacyServiceType =
            quote.serviceCatalog?.legacyServiceType ??
            inferLegacyServiceType(quote.serviceNameSnapshot ?? quote.serviceType ?? "");
        const booking = await tx.booking.create({
            data: {
                bookingRef,
                adminId,
                clientId: quote.clientId,
                serviceCatalogId: quote.serviceCatalogId,
                serviceType: legacyServiceType,
                serviceNameSnapshot: serviceDisplayName(quote),
                priceSnapshot: quote.serviceCatalog?.basePrice ?? null,
                durationSnapshot: quote.serviceCatalog?.duration ?? null,
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
    // Internal lookup key only; stripped before the public DTO is returned.
    id: true,
    quoteRef: true,
    status: true,
    serviceType: true,
    serviceNameSnapshot: true,
    serviceCatalog: { select: { serviceName: true } },
    address: true,
    subtotal: true,
    taxRate: true,
    tax: true,
    total: true,
    validUntil: true,
    notes: true,
    publishedAt: true,
    sentAt: true,
    respondedAt: true,
    responseNote: true,
    createdAt: true,
    lineItems: {
        select: {
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
            mobileNumber: true,
            currency: true,
            businessWebsite: {
                select: {
                    primaryColor: true,
                    secondaryColor: true,
                    accentColor: true,
                    logo: true,
                    subdomain: true,
                },
            },
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
        "This quote has expired and can no longer be shared or accepted.",
        { code: "QUOTE_EXPIRED", retryable: false },
    );

const getPublicQuote = async (publicToken: string, websiteId?: string) => {
    // Reject obviously invalid values before hitting the database. Return 404
    // rather than validation details so the endpoint does not reveal token
    // format or quote existence information.
    if (!PublicDocumentLinkService.isValidToken(publicToken)) {
        throw publicQuoteNotFound();
    }

    const websiteAdminId = await resolveWebsiteAdminIdForPublicQuote(websiteId);
    let quote = await prisma.quote.findFirst({
        where: {
            publicToken,
            publishedAt: { not: null },
            ...(websiteAdminId ? { adminId: websiteAdminId } : {}),
        },
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

    const { id: _internalQuoteId, ...publicQuote } = quote;
    return publicQuote;
};

const publicQuoteAction = async (
    publicToken: string,
    action: "accept" | "decline",
    note?: string,
    websiteId?: string,
) => {
    if (!PublicDocumentLinkService.isValidToken(publicToken)) {
        throw publicQuoteNotFound();
    }

    const websiteAdminId = await resolveWebsiteAdminIdForPublicQuote(websiteId);
    const quote = await prisma.quote.findFirst({
        where: {
            publicToken,
            publishedAt: { not: null },
            ...(websiteAdminId ? { adminId: websiteAdminId } : {}),
        },
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
        return getPublicQuote(publicToken, websiteId);
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
        if (current.status === newStatus) return getPublicQuote(publicToken, websiteId);
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

    return getPublicQuote(publicToken, websiteId);
};

// ─── Share lifecycle ──────────────────────────────────────────────────────────

const loadPublishedQuoteForAdmin = async (
    id: string,
    adminId: string,
    shareUrl: string,
) => {
    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        include: quoteInclude,
    });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");
    return { ...quote, shareUrl };
};

const shareQuote = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const publication = await PublicDocumentPublicationService.publishQuote({
        id,
        adminId,
        intent: "PUBLISH",
    });
    return loadPublishedQuoteForAdmin(id, adminId, publication.shareUrl);
};

// ─── Send quote email ─────────────────────────────────────────────────────────

const sendQuoteEmail = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const quote = await prisma.quote.findFirst({
        where: { id, adminId },
        select: {
            id: true,
            status: true,
            client: { select: { email: true } },
        },
    });
    if (!quote) throw new AppError(status.NOT_FOUND, "Quote not found");
    if (!quote.client.email) {
        throw new AppError(status.BAD_REQUEST, "Client has no email address on file");
    }

    const publication = await PublicDocumentPublicationService.publishQuote({
        id,
        adminId,
        intent: "SEND",
        onPublishedTx: async (tx, published) => {
            if (!published.sentAt) {
                throw new AppError(status.INTERNAL_SERVER_ERROR, "Quote send timestamp was not created", {
                    code: "QUOTE_SEND_INVARIANT_FAILED",
                    retryable: true,
                });
            }
            await queueQuoteSentNotificationTx(
                tx,
                id,
                published.sentAt.toISOString(),
                published.shareUrl,
            );
        },
    });

    return loadPublishedQuoteForAdmin(id, adminId, publication.shareUrl);
};

// ─── Quote Templates ──────────────────────────────────────────────────────────

export interface IQuoteTemplateLineItemInput {
    description: string;
    quantity: number;
    unitPrice: number;
}

export interface IQuoteTemplateCreate {
    name: string;
    serviceCatalogId?: string;
    serviceType?: string;
    taxRate?: number;
    notes?: string;
    lineItems: IQuoteTemplateLineItemInput[];
}

export interface IQuoteTemplateUpdate {
    name?: string;
    serviceCatalogId?: string | null;
    serviceType?: string;
    taxRate?: number;
    notes?: string;
    lineItems?: IQuoteTemplateLineItemInput[];
}

const templateInclude = {
    lineItems: true,
    serviceCatalog: { select: { id: true, serviceName: true, basePrice: true, duration: true } },
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
    const serviceIdentity = await resolveFlexibleServiceIdentity(adminId, {
        serviceCatalogId: payload.serviceCatalogId,
        serviceType: payload.serviceType,
    });

    return prisma.quoteTemplate.create({
        data: {
            adminId,
            name: payload.name,
            serviceCatalogId: serviceIdentity.serviceCatalogId,
            serviceType: serviceIdentity.serviceType,
            serviceNameSnapshot: serviceIdentity.serviceNameSnapshot,
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

    const serviceIdentity =
        payload.serviceCatalogId !== undefined || payload.serviceType !== undefined
            ? await resolveFlexibleServiceIdentity(adminId, {
                  serviceCatalogId: payload.serviceCatalogId ?? undefined,
                  serviceType: payload.serviceType,
              })
            : null;

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
                ...(serviceIdentity && {
                    serviceCatalogId: serviceIdentity.serviceCatalogId,
                    serviceType: serviceIdentity.serviceType,
                    serviceNameSnapshot: serviceIdentity.serviceNameSnapshot,
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
        include: {
            lineItems: true,
            client: { select: { id: true } },
            serviceCatalog: { select: { id: true, serviceName: true, basePrice: true, duration: true, legacyServiceType: true } },
        },
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


    const job = await prisma.$transaction(async (tx) => {
        const jobRef = await nextReference(tx, "job");
        const legacyServiceType =
            quote.serviceCatalog?.legacyServiceType ??
            inferLegacyServiceType(quote.serviceNameSnapshot ?? quote.serviceType ?? "");
        const created = await tx.job.create({
            data: {
                jobRef,
                adminId,
                clientId: quote.clientId,
                serviceCatalogId: quote.serviceCatalogId,
                serviceType: legacyServiceType,
                serviceNameSnapshot: serviceDisplayName(quote),
                priceSnapshot: quote.serviceCatalog?.basePrice ?? null,
                durationSnapshot: quote.serviceCatalog?.duration ?? null,
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
    shareQuote,
    sendQuoteEmail,
    getAllQuoteTemplates,
    createQuoteTemplate,
    updateQuoteTemplate,
    deleteQuoteTemplate,
    recordTemplateUsage,
};
