import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { EstimateStatus } from "../../generated/prisma/enums";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generates a unique estimate reference: #OP-EST-0001
 */
const generateEstimateRef = async (): Promise<string> => {
    const last = await prisma.estimate.findFirst({
        orderBy: { createdAt: "desc" },
        select: { estimateRef: true },
    });

    let next = 1;
    if (last?.estimateRef) {
        const parts = last.estimateRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) next = num + 1;
    }

    return `#OP-EST-${next.toString().padStart(4, "0")}`;
};

/**
 * Resolve adminProfile.id from the authenticated user id.
 */
const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
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
} as const;

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createEstimate = async (payload: IEstimateCreate, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    // Verify client belongs to this admin
    const client = await prisma.client.findFirst({
        where: { id: payload.clientId, adminId },
    });
    if (!client) throw new AppError(status.NOT_FOUND, "Client not found");

    const estimateRef = await generateEstimateRef();
    const totals = computeTotals(
        payload.lineItems,
        payload.discountType ?? "percent",
        payload.discountValue ?? 0,
    );

    return prisma.estimate.create({
        data: {
            estimateRef,
            adminId,
            clientId: payload.clientId,
            serviceType: payload.serviceType,
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
                        total:
                            Math.round(
                                item.quantity *
                                    item.unitPrice *
                                    (1 - (item.discountPercent ?? 0) / 100) *
                                    (1 + (item.taxPercent ?? 20) / 100) *
                                    100,
                            ) / 100,
                    })),
                },
            },
        },
        include: estimateInclude,
    });
};

const getAllEstimates = async (
    queryParams: IQueryParams,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

    const estimate = await prisma.estimate.findFirst({
        where: { id, adminId },
        include: estimateInclude,
    });

    if (!estimate) throw new AppError(status.NOT_FOUND, "Estimate not found");

    return estimate;
};

const updateEstimate = async (
    id: string,
    payload: IEstimateUpdate,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

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
                ...(payload.serviceType && {
                    serviceType: payload.serviceType,
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

const updateEstimateStatus = async (
    id: string,
    newStatus: EstimateStatus,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.estimate.findFirst({
        where: { id, adminId },
    });
    if (!existing) throw new AppError(status.NOT_FOUND, "Estimate not found");

    if (!ALLOWED_TRANSITIONS[existing.status].includes(newStatus)) {
        throw new AppError(
            status.BAD_REQUEST,
            `Cannot transition estimate from ${existing.status} to ${newStatus}`,
        );
    }

    const data: Record<string, unknown> = { status: newStatus };

    // Record sentAt when first sent
    if (newStatus === EstimateStatus.SENT && !existing.sentAt) {
        data.sentAt = new Date();
    }

    return prisma.estimate.update({
        where: { id },
        data,
        include: estimateInclude,
    });
};

const deleteEstimate = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

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
    const adminId = await resolveAdminId(user.id);

    const estimate = await prisma.estimate.findFirst({
        where: { id, adminId },
        include: { lineItems: true },
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

    return prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({
            data: {
                bookingRef,
                adminId,
                clientId: estimate.clientId,
                serviceType: "RESIDENTIAL_CLEAN" as any,
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
    const adminId = await resolveAdminId(user.id);

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

    const quoteRef = await generateQuoteRef();

    // Re-use estimate totals: tax = estimate.tax, taxRate = estimate.taxRate
    const subtotal = Number(estimate.subtotal);
    const tax = Number(estimate.tax);
    const taxRate = Number(estimate.taxRate);
    const total = Number(estimate.total);

    const quote = await prisma.$transaction(async (tx) => {
        const newQuote = await tx.quote.create({
            data: {
                quoteRef,
                adminId,
                clientId: estimate.clientId,
                serviceType: estimate.serviceType,
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
    deleteEstimate,
    convertEstimateToBooking,
    convertEstimateToQuote,
};
