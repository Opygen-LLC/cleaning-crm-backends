import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import { EstimateStatus, NotificationType } from "../../generated/prisma/enums";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";
import {
    IEstimateCreate,
    IEstimateUpdate,
    IEstimateLineItemInput,
    IEstimateConvertToBooking,
} from "./estimate.interface";
import {
    estimateSearchableFields,
    estimateFilterableFields,
} from "./estimate.constant";
import { IRequestUser } from "../../types/requestUser.interface";
import { assertWithinLimit } from "../../lib/utils/checkPlanLimits";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { requireE164Phone } from "../../lib/validation/phone";
import { quoteInclude } from "../Quote/quote.service";
import { nextReference } from "../../lib/utils/referenceNumber";
import {
    inferLegacyServiceType,
    resolveFlexibleServiceIdentity,
} from "../../lib/utils/serviceIdentity";
import { PublicDocumentLinkService } from "../Website/publicDocumentLink.service";
import { PublicDocumentPublicationService } from "../Website/publicDocumentPublication.service";
import { queueEstimateSentNotificationTx } from "../../lib/notifications/businessNotificationEvents";
import { createNotification } from "../../lib/utils/createNotification";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isPublicUrlConfigurationError = (error: unknown): boolean =>
    error instanceof AppError &&
    [
        "WEBSITE_REQUIRED_FOR_PUBLIC_LINK",
        "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE",
    ].includes(error.code ?? "");

const publicEstimateNotFound = () =>
    new AppError(status.NOT_FOUND, "Estimate not found", {
        code: "ESTIMATE_NOT_FOUND",
        retryable: false,
    });

const estimateExpiredError = () =>
    new AppError(
        status.GONE,
        "This estimate has expired and can no longer be approved or rejected.",
        { code: "ESTIMATE_EXPIRED", retryable: false },
    );

const resolveEstimateShareUrlIfAvailable = async (
    adminId: string,
    publicToken: string | null,
): Promise<string | null> => {
    if (!publicToken) return null;
    try {
        return await PublicDocumentLinkService.buildPublicDocumentUrl({
            adminId,
            resourceType: "estimate",
            token: publicToken,
        });
    } catch (error) {
        if (isPublicUrlConfigurationError(error)) return null;
        throw error;
    }
};

const withEstimateShareUrl = async <T extends {
    publicToken: string | null;
    status: EstimateStatus;
    publishedAt: Date | null;
}>(
    adminId: string,
    estimate: T,
): Promise<T & { shareUrl: string | null }> => ({
    ...estimate,
    shareUrl:
        estimate.status === EstimateStatus.DRAFT || !estimate.publishedAt
            ? null
            : await resolveEstimateShareUrlIfAvailable(adminId, estimate.publicToken),
});

const resolveWebsiteAdminIdForPublicEstimate = async (
    websiteId?: string,
): Promise<string | null> => {
    try {
        return await PublicDocumentLinkService.resolveWebsiteAdminId(websiteId);
    } catch {
        throw publicEstimateNotFound();
    }
};

/**
 * Compute estimate totals from line items with per-line tax and discount,
 * plus an optional global discount.
 *
 * Formula per line:
 *   lineSubtotal   = qty × unitPrice
 *   lineDiscounted = lineSubtotal × (1 - discountPercent/100)
 *   lineTax        = lineDiscounted × (taxPercent/100)
 *   lineTotal      = lineDiscounted + lineTax
 *
 * Grand totals:
 *   subtotal       = Σ lineSubtotal
 *   itemDiscounts  = Σ (lineSubtotal − lineDiscounted)
 *   afterItemDisc  = subtotal − itemDiscounts
 *   globalDisc     = percent: afterItemDisc × (discountValue/100) | fixed: min(discountValue, afterItemDisc)
 *   taxTotal       = Σ lineTax   (tax is on discounted line, before global disc)
 *   total          = afterItemDisc − globalDisc + taxTotal
 */
interface ComputedTotals {
    subtotal: number;
    labourCost: number; // re-used for subtotal pre-tax pre-disc
    materialCost: number; // set to 0 (not collected at this layer)
    overheadCost: number; // set to 0
    marginPercent: number; // set to 0
    taxRate: number; // blended effective rate (info only)
    tax: number;
    total: number;
}

const computeTotals = (
    lineItems: IEstimateLineItemInput[],
    discountType: "percent" | "fixed",
    discountValue: number,
): ComputedTotals => {
    const round2 = (n: number) => Math.round(n * 100) / 100;

    let subtotal = 0;
    let discountedSum = 0;
    let taxSum = 0;

    for (const item of lineItems) {
        const lineSub = round2(item.quantity * item.unitPrice);
        const lineDiscounted = round2(
            lineSub * (1 - (item.discountPercent ?? 0) / 100),
        );
        const lineTax = round2(
            lineDiscounted * ((item.taxPercent ?? 20) / 100),
        );

        subtotal += lineSub;
        discountedSum += lineDiscounted;
        taxSum += lineTax;
    }

    subtotal = round2(subtotal);
    discountedSum = round2(discountedSum);
    taxSum = round2(taxSum);

    // Global discount applied on top of item discounts
    let globalDiscount = 0;
    if (discountValue > 0) {
        globalDiscount =
            discountType === "percent"
                ? round2(discountedSum * (discountValue / 100))
                : Math.min(round2(discountValue), discountedSum);
    }

    const afterAllDiscounts = round2(discountedSum - globalDiscount);
    const total = round2(afterAllDiscounts + taxSum);

    // Blended tax rate for informational storage
    const blendedTaxRate =
        afterAllDiscounts > 0 ? round2((taxSum / afterAllDiscounts) * 100) : 0;

    return {
        subtotal,
        labourCost: subtotal, // maps to Prisma labourCost field
        materialCost: 0,
        overheadCost: 0,
        marginPercent: 0,
        taxRate: blendedTaxRate,
        tax: taxSum,
        total,
    };
};

// ─── Status transition guard ──────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
    [EstimateStatus.DRAFT]: [EstimateStatus.SENT, EstimateStatus.REJECTED],
    [EstimateStatus.SENT]: [EstimateStatus.APPROVED, EstimateStatus.REJECTED],
    [EstimateStatus.APPROVED]: [EstimateStatus.CONVERTED], // convert via dedicated endpoint
    [EstimateStatus.REJECTED]: [], // terminal
    [EstimateStatus.CONVERTED]: [], // terminal
};

// ─── Standard includes ─────────────────────────────────────────────────────────

const estimateInclude = {
    client: {
        select: { id: true, name: true, email: true, phone: true },
    },
    lineItems: true,
    jobs: {
        select: { id: true, jobRef: true, status: true },
    },
    serviceCatalog: {
        select: { id: true, serviceName: true, basePrice: true, duration: true, legacyServiceType: true },
    },
} as const;

const publicEstimateSelect = {
    estimateRef: true,
    status: true,
    serviceType: true,
    serviceNameSnapshot: true,
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
    lineItems: {
        select: {
            description: true,
            quantity: true,
            unitPrice: true,
            total: true,
        },
    },
    serviceCatalog: { select: { serviceName: true } },
    client: { select: { name: true } },
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

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createEstimate = async (payload: IEstimateCreate, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    if (Boolean(payload.clientId) === Boolean(payload.newClient)) {
        throw new AppError(status.BAD_REQUEST, "Choose exactly one client mode: existing client or new client", {
            code: "VALIDATION_ERROR",
            retryable: false,
            fieldErrors: { clientId: "Choose an existing client or enter a new client, not both." },
        });
    }

    if (payload.newClient) await assertWithinLimit(adminId, "client");

    const [serviceIdentity, totals, publication] = await Promise.all([
        resolveFlexibleServiceIdentity(adminId, {
            serviceCatalogId: payload.serviceCatalogId,
            serviceType: payload.serviceType,
        }),
        Promise.resolve(computeTotals(
            payload.lineItems,
            payload.discountType ?? "percent",
            payload.discountValue ?? 0,
        )),
        PublicDocumentPublicationService.prepareCreation({
            adminId,
            resourceType: "estimate",
            deliveryIntent: payload.deliveryIntent,
        }),
    ]);

    const estimate = await prisma.$transaction(async (tx) => {
        let clientId: string;

        if (payload.clientId) {
            const client = await tx.client.findFirst({
                where: { id: payload.clientId, adminId },
                select: { id: true, email: true },
            });
            if (!client) {
                throw new AppError(status.NOT_FOUND, "Client not found", {
                    code: "CLIENT_NOT_FOUND",
                    retryable: false,
                    fieldErrors: { clientId: "Choose a client from this business." },
                });
            }
            if (payload.deliveryIntent === "SEND" && !client.email) {
                throw new AppError(status.BAD_REQUEST, "Client has no email address on file", {
                    code: "ESTIMATE_CLIENT_EMAIL_REQUIRED",
                    retryable: false,
                });
            }
            clientId = client.id;
        } else {
            const newClient = payload.newClient!;
            const email = newClient.email.trim().toLowerCase();
            const phone = requireE164Phone(newClient.phone, "newClient.phone");

            await acquireExtendedTextTransactionAdvisoryLock(
                tx,
                `estimate-new-client:${adminId}:${email}`,
            );

            const existing = await tx.client.findUnique({
                where: { email_adminId: { email, adminId } },
                select: { id: true },
            });
            if (existing) {
                throw new AppError(status.CONFLICT, "A client with this email already exists", {
                    code: "CLIENT_EMAIL_EXISTS",
                    retryable: false,
                    fieldErrors: { "newClient.email": "This client already exists. Use the Existing Client tab." },
                });
            }

            const created = await tx.client.create({
                data: {
                    adminId,
                    name: newClient.name.trim(),
                    email,
                    phone,
                    addressLine1: newClient.addressLine1.trim(),
                    city: newClient.city?.trim() ?? "",
                    zipcode: newClient.postcode?.trim() ?? "",
                    country: newClient.country?.trim() ?? "",
                    servicePreference: serviceIdentity.serviceNameSnapshot ?? serviceIdentity.serviceType ?? "",
                },
                select: { id: true },
            });
            clientId = created.id;
        }

        const estimateRef = await nextReference(tx, "estimate");
        const created = await tx.estimate.create({
            data: {
                estimateRef,
                publicToken: publication.publicToken,
                status: publication.status,
                publishedAt: publication.publishedAt,
                sentAt: publication.sentAt,
                adminId,
                clientId,
                serviceCatalogId: serviceIdentity.serviceCatalogId,
                serviceType: serviceIdentity.serviceType,
                serviceNameSnapshot: serviceIdentity.serviceNameSnapshot,
                address: payload.address,
                labourCost: totals.labourCost,
                materialCost: totals.materialCost,
                overheadCost: totals.overheadCost,
                marginPercent: totals.marginPercent,
                subtotal: totals.subtotal,
                taxRate: totals.taxRate,
                tax: totals.tax,
                total: totals.total,
                validUntil: new Date(payload.validUntil),
                notes: payload.notes,
                internalNotes: payload.internalNotes,
                lineItems: {
                    createMany: {
                        data: payload.lineItems.map((item) => ({
                            description: item.description,
                            quantity: item.quantity,
                            unitPrice: item.unitPrice,
                            total: Math.round(
                                item.quantity * item.unitPrice *
                                (1 - (item.discountPercent ?? 0) / 100) *
                                (1 + (item.taxPercent ?? 20) / 100) * 100,
                            ) / 100,
                        })),
                    },
                },
            },
            include: estimateInclude,
        });

        if (payload.deliveryIntent === "SEND" && publication.sentAt && publication.shareUrl) {
            await queueEstimateSentNotificationTx(
                tx,
                created.id,
                publication.sentAt.toISOString(),
                publication.shareUrl,
            );
        }

        return created;
    });

    return { ...estimate, shareUrl: publication.shareUrl };
};

const getAllEstimates = async (
    queryParams: IQueryParams,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    return new QueryBuilder(prisma.estimate, queryParams, {
        searchableFields: estimateSearchableFields,
        filterableFields: estimateFilterableFields,
    })
        .where({ adminId })
        .search()
        .filter()
        .sort()
        .paginate()
        .include(estimateInclude)
        .execute();
};

const getEstimateById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const estimate = await prisma.estimate.findFirst({
        where: { id, adminId },
        include: estimateInclude,
    });

    if (!estimate) throw new AppError(status.NOT_FOUND, "Estimate not found");

    return withEstimateShareUrl(adminId, estimate);
};

const updateEstimate = async (
    id: string,
    payload: IEstimateUpdate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.estimate.findFirst({
        where: { id, adminId },
    });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate not found");

    if (existing.status !== EstimateStatus.DRAFT) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot edit an estimate with status ${existing.status}. Only DRAFT estimates are editable.`,
        );
    }

    const serviceIdentity =
        payload.serviceCatalogId !== undefined || payload.serviceType !== undefined
            ? await resolveFlexibleServiceIdentity(adminId, {
                  serviceCatalogId: payload.serviceCatalogId ?? undefined,
                  serviceType: payload.serviceType,
              })
            : null;

    // Recompute totals if line items or discount changed
    let totalsUpdate: Partial<ComputedTotals> | null = null;
    const lineItemsToUse = payload.lineItems;

    if (lineItemsToUse) {
        totalsUpdate = computeTotals(
            lineItemsToUse,
            payload.discountType ?? "percent",
            payload.discountValue ?? 0,
        );
    }

    return prisma.$transaction(async (tx) => {
        if (lineItemsToUse) {
            await tx.estimateLineItem.deleteMany({ where: { estimateId: id } });
            await tx.estimateLineItem.createMany({
                data: lineItemsToUse.map((item) => ({
                    estimateId: id,
                    description: item.description,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    total:
                        Math.round(
                            item.quantity *
                                item.unitPrice *
                                (1 - (item.discountPercent ?? 0) / 100) *
                                (1 + (item.taxPercent ?? 20) / 100) *
                                100,
                        ) / 100,
                })),
            });
        }

        return tx.estimate.update({
            where: { id },
            data: {
                ...(serviceIdentity && {
                    serviceCatalogId: serviceIdentity.serviceCatalogId,
                    serviceType: serviceIdentity.serviceType,
                    serviceNameSnapshot: serviceIdentity.serviceNameSnapshot,
                }),
                ...(payload.address && { address: payload.address }),
                ...(payload.validUntil && {
                    validUntil: new Date(payload.validUntil),
                }),
                ...(payload.notes !== undefined && { notes: payload.notes }),
                ...(payload.internalNotes !== undefined && {
                    internalNotes: payload.internalNotes,
                }),
                ...(totalsUpdate && {
                    subtotal: totalsUpdate.subtotal,
                    labourCost: totalsUpdate.labourCost,
                    taxRate: totalsUpdate.taxRate,
                    tax: totalsUpdate.tax,
                    total: totalsUpdate.total,
                }),
            },
            include: estimateInclude,
        });
    });
};

/**
 * Updates estimate status (DRAFT -> SENT -> APPROVED / REJECTED).
 * Note: Estimate status transitions do NOT alter actual revenue, active bookings,
 * or completed job metrics on top-level dashboard overview until explicitly converted.
 */
const updateEstimateStatus = async (
    id: string,
    newStatus: EstimateStatus,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    if (newStatus === EstimateStatus.SENT) {
        const publication = await PublicDocumentPublicationService.publishEstimate({
            id,
            adminId,
            intent: "PUBLISH",
        });
        const updated = await prisma.estimate.findFirst({ where: { id, adminId }, include: estimateInclude });
        if (!updated) throw new AppError(status.NOT_FOUND, "Estimate not found");
        return { ...updated, shareUrl: publication.shareUrl };
    }

    const existing = await prisma.estimate.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate not found");

    if (!ALLOWED_TRANSITIONS[existing.status].includes(newStatus)) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot transition estimate from ${existing.status} to ${newStatus}`,
        );
    }

    const now = new Date();
    const updated = await prisma.estimate.update({
        where: { id },
        data: {
            status: newStatus,
            ...((newStatus === EstimateStatus.APPROVED || newStatus === EstimateStatus.REJECTED) && !existing.respondedAt
                ? { respondedAt: now }
                : {}),
        },
        include: estimateInclude,
    });
    return withEstimateShareUrl(adminId, updated);
};

// ─── Public client document + canonical share lifecycle ──────────────────────

const getPublicEstimate = async (publicToken: string, websiteId?: string) => {
    if (!PublicDocumentLinkService.isValidToken(publicToken)) {
        throw publicEstimateNotFound();
    }

    const websiteAdminId = await resolveWebsiteAdminIdForPublicEstimate(websiteId);
    const estimate = await prisma.estimate.findFirst({
        where: {
            publicToken,
            publishedAt: { not: null },
            ...(websiteAdminId ? { adminId: websiteAdminId } : {}),
        },
        select: publicEstimateSelect,
    });

    if (!estimate || estimate.status === EstimateStatus.DRAFT) {
        throw publicEstimateNotFound();
    }

    return {
        ...estimate,
        isExpired:
            estimate.status === EstimateStatus.SENT &&
            new Date() > estimate.validUntil,
    };
};

const publicEstimateAction = async (
    publicToken: string,
    action: "approve" | "reject",
    note?: string,
    websiteId?: string,
) => {
    if (!PublicDocumentLinkService.isValidToken(publicToken)) {
        throw publicEstimateNotFound();
    }

    const websiteAdminId = await resolveWebsiteAdminIdForPublicEstimate(websiteId);
    const estimate = await prisma.estimate.findFirst({
        where: {
            publicToken,
            publishedAt: { not: null },
            ...(websiteAdminId ? { adminId: websiteAdminId } : {}),
        },
        select: {
            id: true,
            estimateRef: true,
            adminId: true,
            status: true,
            validUntil: true,
        },
    });

    if (!estimate || estimate.status === EstimateStatus.DRAFT) {
        throw publicEstimateNotFound();
    }

    const newStatus =
        action === "approve" ? EstimateStatus.APPROVED : EstimateStatus.REJECTED;

    if (estimate.status === newStatus) {
        return getPublicEstimate(publicToken, websiteId);
    }

    if (
        estimate.status === EstimateStatus.APPROVED ||
        estimate.status === EstimateStatus.REJECTED ||
        estimate.status === EstimateStatus.CONVERTED
    ) {
        throw new AppError(
            status.CONFLICT,
            `This estimate has already been ${estimate.status.toLowerCase()}.`,
            { code: "ESTIMATE_ALREADY_RESPONDED", retryable: false },
        );
    }

    const now = new Date();
    if (now > estimate.validUntil) throw estimateExpiredError();
    if (estimate.status !== EstimateStatus.SENT) {
        throw new AppError(
            status.CONFLICT,
            "This estimate is no longer awaiting a client response.",
            { code: "ESTIMATE_NOT_ACTIONABLE", retryable: false },
        );
    }

    const cleanNote = note?.trim() || null;
    const transition = await prisma.estimate.updateMany({
        where: {
            id: estimate.id,
            status: EstimateStatus.SENT,
            validUntil: { gte: now },
        },
        data: {
            status: newStatus,
            respondedAt: now,
            responseNote: action === "reject" ? cleanNote : null,
        },
    });

    if (transition.count === 0) {
        const current = await prisma.estimate.findUnique({
            where: { id: estimate.id },
            select: { status: true, validUntil: true },
        });
        if (!current) throw publicEstimateNotFound();
        if (current.status === newStatus) return getPublicEstimate(publicToken, websiteId);
        if (now > current.validUntil) throw estimateExpiredError();
        throw new AppError(
            status.CONFLICT,
            `This estimate has already been ${current.status.toLowerCase()}.`,
            { code: "ESTIMATE_ALREADY_RESPONDED", retryable: false },
        );
    }

    createNotification({
        adminId: estimate.adminId,
        type: NotificationType.GENERAL,
        title: `Estimate ${estimate.estimateRef} ${action === "approve" ? "approved" : "rejected"}`,
        message:
            action === "approve"
                ? "Client approved the estimate — it is ready to convert to a booking or quote."
                : cleanNote
                  ? `Client rejected the estimate: ${cleanNote}`
                  : "Client rejected the estimate.",
        relatedId: estimate.id,
    }).catch(() => {});

    return getPublicEstimate(publicToken, websiteId);
};

const loadPublishedEstimateForAdmin = async (
    id: string,
    adminId: string,
    shareUrl: string,
) => {
    const estimate = await prisma.estimate.findFirst({
        where: { id, adminId },
        include: estimateInclude,
    });
    if (!estimate) throw new AppError(status.NOT_FOUND, "Estimate not found");
    return { ...estimate, shareUrl };
};

const shareEstimate = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const publication = await PublicDocumentPublicationService.publishEstimate({
        id,
        adminId,
        intent: "PUBLISH",
    });
    return loadPublishedEstimateForAdmin(id, adminId, publication.shareUrl);
};

const sendEstimateEmail = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const estimate = await prisma.estimate.findFirst({
        where: { id, adminId },
        select: { id: true, status: true, client: { select: { email: true } } },
    });
    if (!estimate) throw new AppError(status.NOT_FOUND, "Estimate not found");
    if (!estimate.client.email) {
        throw new AppError(status.BAD_REQUEST, "Client has no email address on file");
    }

    const publication = await PublicDocumentPublicationService.publishEstimate({
        id,
        adminId,
        intent: "SEND",
        onPublishedTx: async (tx, published) => {
            if (!published.sentAt) {
                throw new AppError(status.INTERNAL_SERVER_ERROR, "Estimate send timestamp was not created", {
                    code: "ESTIMATE_SEND_INVARIANT_FAILED",
                    retryable: true,
                });
            }
            await queueEstimateSentNotificationTx(
                tx,
                id,
                published.sentAt.toISOString(),
                published.shareUrl,
            );
        },
    });

    return loadPublishedEstimateForAdmin(id, adminId, publication.shareUrl);
};

const deleteEstimate = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.estimate.findFirst({
        where: { id, adminId },
    });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate not found");

    if (existing.status === EstimateStatus.CONVERTED) {
        throw new AppError(
            status.BAD_REQUEST,
            "Cannot delete a converted estimate. Archive the linked booking instead.",
        );
    }

    await prisma.estimate.delete({ where: { id } });
};

// ─── Convert APPROVED estimate → Booking ─────────────────────────────────────

const convertEstimateToBooking = async (
    id: string,
    payload: IEstimateConvertToBooking,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const estimate = await prisma.estimate.findFirst({
        where: { id, adminId },
        include: {
            lineItems: true,
            serviceCatalog: {
                select: { id: true, serviceName: true, basePrice: true, duration: true, legacyServiceType: true },
            },
        },
    });
    if (!estimate) throw new AppError(status.NOT_FOUND, "Estimate not found");

    if (estimate.status !== EstimateStatus.APPROVED) {
        throw new AppError(
            status.BAD_REQUEST,
            `Only APPROVED estimates can be converted to bookings. Current status: ${estimate.status}`,
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
            estimate.serviceCatalog?.legacyServiceType ??
            inferLegacyServiceType(
                estimate.serviceNameSnapshot ?? estimate.serviceType ?? "",
            );

        const booking = await tx.booking.create({
            data: {
                bookingRef,
                adminId,
                clientId: estimate.clientId,
                serviceCatalogId: estimate.serviceCatalogId,
                serviceType: legacyServiceType,
                serviceNameSnapshot:
                    estimate.serviceNameSnapshot ??
                    estimate.serviceCatalog?.serviceName ??
                    estimate.serviceType ??
                    "Service",
                priceSnapshot: estimate.serviceCatalog?.basePrice ?? null,
                durationSnapshot: estimate.serviceCatalog?.duration ?? null,
                address: estimate.address,
                scheduledDate: new Date(payload.scheduledDate),
                durationMins: payload.durationMins,
                total: estimate.total,
                notes: payload.notes ?? estimate.notes,
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

        // Mark estimate as converted and record the booking ref
        await tx.estimate.update({
            where: { id },
            data: {
                status: EstimateStatus.CONVERTED,
                convertedToBookingRef: bookingRef,
            },
        });

        // Update client aggregates
        await tx.client.update({
            where: { id: estimate.clientId },
            data: {
                totalBookings: { increment: 1 },
                lastBookingDate: new Date(payload.scheduledDate),
            },
        });

        return booking;
    });
};

// ─── Convert APPROVED estimate → Quote ──────────────────────────────────────

/**
 * Creates a pre-filled Quote from an APPROVED Estimate.
 * The estimate stays in APPROVED status — it is only marked CONVERTED
 * when subsequently converted to a Booking.
 */
const convertEstimateToQuote = async (
    id: string,
    payload: { validUntil: string; notes?: string; internalNotes?: string },
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const estimate = await prisma.estimate.findFirst({
        where: { id, adminId },
        include: { lineItems: true },
    });
    if (!estimate) throw new AppError(status.NOT_FOUND, "Estimate not found");

    if (estimate.status !== EstimateStatus.APPROVED) {
        throw new AppError(
            status.BAD_REQUEST,
            `Only APPROVED estimates can be converted to quotes. Current status: ${estimate.status}`,
        );
    }

    // Re-use estimate totals: tax = estimate.tax, taxRate = estimate.taxRate
    const subtotal = Number(estimate.subtotal);
    const tax = Number(estimate.tax);
    const taxRate = Number(estimate.taxRate);
    const total = Number(estimate.total);

    const quote = await prisma.$transaction(async (tx) => {
        const quoteRef = await nextReference(tx, "quote");
        const newQuote = await tx.quote.create({
            data: {
                quoteRef,
                adminId,
                clientId: estimate.clientId,
                serviceCatalogId: estimate.serviceCatalogId,
                serviceType: estimate.serviceType,
                serviceNameSnapshot:
                    estimate.serviceNameSnapshot ?? estimate.serviceType ?? "Service",
                address: estimate.address,
                subtotal,
                taxRate,
                tax,
                total,
                validUntil: new Date(payload.validUntil),
                notes: payload.notes ?? estimate.notes,
                internalNotes: payload.internalNotes ?? estimate.internalNotes,
                lineItems: {
                    createMany: {
                        data: estimate.lineItems.map((li) => ({
                            description: li.description,
                            quantity: li.quantity,
                            unitPrice: Number(li.unitPrice),
                            total: Number(li.total),
                        })),
                    },
                },
            },
            include: quoteInclude,
        });

        // Stamp estimate so the UI can show "Converted to quote QREF-xxx"
        await tx.estimate.update({
            where: { id },
            data: { convertedToQuoteRef: quoteRef },
        });

        return newQuote;
    });

    return quote;
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const estimateService = {
    createEstimate,
    getAllEstimates,
    getEstimateById,
    updateEstimate,
    updateEstimateStatus,
    shareEstimate,
    sendEstimateEmail,
    getPublicEstimate,
    publicEstimateAction,
    deleteEstimate,
    convertEstimateToBooking,
    convertEstimateToQuote,
};
