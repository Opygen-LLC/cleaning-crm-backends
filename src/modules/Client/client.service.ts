import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { IRequestUser } from "../../types/requestUser.interface";
import { createClientPayload, updateClientPayload } from "./client.interface";
import { prisma } from "../../lib/prisma/prisma";
import { assertWithinLimit } from "../../lib/utils/checkPlanLimits";
import { IQueryParams } from "../../interface/query.interface";
import { Client, Prisma } from "../../generated/prisma/client";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import {
    clientFilterableFields,
    clientSearchableFields,
} from "./client.constant";
import { randomUUID } from "crypto";
import {
    buildAddressString,
    geocodeAddressSafely,
} from "../../lib/utils/geocoding";

/**
 * Geocodes the client's structured address into lat/lng. Never throws —
 * on failure this just resolves to `{}`, and the client is created/updated
 * without coordinates (dispatch proximity scoring skips it gracefully).
 */
const geocodeClientAddress = async (address: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    zipcode?: string;
    country?: string;
}) => {
    const full = buildAddressString(address);
    if (!full) return {};

    const geo = await geocodeAddressSafely(full);
    if (!geo) return {};

    return {
        latitude: geo.latitude,
        longitude: geo.longitude,
        geocodedAt: new Date(),
    };
};

const resolveAdminId = async (userId: string): Promise<string> => {
    const adminProfile = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { id: true },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    return adminProfile.id;
};

const createClient = async (
    payload: createClientPayload,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    // Enforce plan limits before inserting
    await assertWithinLimit(adminId, "client");

    const { notes, servicePreference, email, ...rest } = payload;

    // Best-effort geocode — never blocks client creation on a bad/unmatched
    // address or a provider outage.
    const geo = await geocodeClientAddress(rest);

    return await prisma.client.upsert({
        where: {
            email_adminId: {
                email,
                adminId,
            },
        },
        create: {
            ...rest,
            email,
            ...(servicePreference ? { servicePreference } : {}),
            ...geo,
            adminId,
            notes: notes
                ? {
                      create: {
                          text: notes,
                      },
                  }
                : undefined,
        },
        update: {
            ...rest,
            ...(servicePreference ? { servicePreference } : {}),
            ...geo,
            notes: notes
                ? {
                      create: {
                          text: notes,
                      },
                  }
                : undefined,
        },
        include: {
            notes: true,
        },
    });
};

const getClients = async (query: IQueryParams, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const queryBuilder = new QueryBuilder<
        Client,
        Prisma.ClientWhereInput,
        Prisma.ClientInclude
    >(prisma.client, query, {
        searchableFields: clientSearchableFields,
        filterableFields: clientFilterableFields,
    });

    const result = await queryBuilder
        .search()
        .filter()
        .where({ adminId })
        .include({ notes: true })
        .paginate()
        .sort()
        .fields()
        .execute();

    return result;
};

const getClientById = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const client = await prisma.client.findUniqueOrThrow({
        where: { id, adminId },
        include: {
            notes: {
                orderBy: { createdAt: "desc" },
            },
            bookings: {
                orderBy: { scheduledDate: "desc" },
                include: {
                    // Live invoice data per booking — status, ref, and total —
                    // so the admin profile view reflects real payment state
                    // instead of just the booking record on its own.
                    invoice: {
                        select: {
                            id: true,
                            invoiceRef: true,
                            status: true,
                            total: true,
                            dueDate: true,
                            paidDate: true,
                        },
                    },
                },
            },
        },
    });

    // portalAccessToken is always included via the full select above.
    // The admin frontend uses it to build the "Copy portal link" URL.
    return client;
};

const updateClient = async (
    id: string,
    payload: updateClientPayload,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.client.findUnique({
        where: { id, adminId },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Client not found");
    }

    // Only re-geocode when an address field actually changed — avoids an
    // API call (and the tiny risk of it failing) on every unrelated edit,
    // e.g. changing the phone number.
    const addressChanged =
        payload.addressLine1 !== undefined ||
        payload.addressLine2 !== undefined ||
        payload.city !== undefined ||
        payload.zipcode !== undefined ||
        payload.country !== undefined;

    const geo = addressChanged
        ? await geocodeClientAddress({
              addressLine1: payload.addressLine1 ?? existing.addressLine1,
              addressLine2:
                  payload.addressLine2 ?? existing.addressLine2 ?? undefined,
              city: payload.city ?? existing.city,
              zipcode: payload.zipcode ?? existing.zipcode,
              country: payload.country ?? existing.country,
          })
        : {};

    return await prisma.client.update({
        where: { id },
        data: { ...payload, ...geo },
        include: { notes: true },
    });
};

const deleteClient = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.client.findUnique({
        where: { id, adminId },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Client not found");
    }

    return await prisma.client.delete({
        where: { id },
    });
};

// ─── Public portal ────────────────────────────────────────────────────────────

const getClientPortal = async (portalAccessToken: string) => {
    const client = await prisma.client.findUnique({
        where: { portalAccessToken },
        select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            zipcode: true,
            country: true,
            totalSpend: true,
            totalBookings: true,
            lastBookingDate: true,
            bookings: {
                orderBy: { scheduledDate: "desc" },
                take: 20,
                select: {
                    id: true,
                    bookingRef: true,
                    status: true,
                    serviceType: true,
                    address: true,
                    scheduledDate: true,
                    durationMins: true,
                    total: true,
                    job: {
                        select: {
                            id: true,
                            jobRef: true,
                            status: true,
                            staffAssignments: {
                                include: {
                                    staff: {
                                        include: {
                                            user: { select: { name: true } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    invoice: {
                        select: {
                            id: true,
                            invoiceRef: true,
                            status: true,
                            total: true,
                            dueDate: true,
                        },
                    },
                },
            },
        },
    });

    if (!client) throw new AppError(status.NOT_FOUND, "Client not found.");

    return client;
};

// ─── Admin: regenerate portal access token ────────────────────────────────────
//
// Rotates the portalAccessToken to a fresh UUID.  The old link immediately
// stops working.  The response returns the new token so the admin can copy
// the new URL without refreshing.

const regeneratePortalToken = async (id: string, user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.client.findUnique({
        where: { id, adminId },
        select: { id: true },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Client not found");
    }

    const updated = await prisma.client.update({
        where: { id },
        data: { portalAccessToken: randomUUID() },
        select: {
            id: true,
            portalAccessToken: true,
        },
    });

    return updated;
};

export const clientService = {
    createClient,
    getClients,
    getClientById,
    updateClient,
    deleteClient,
    getClientPortal,
    regeneratePortalToken,
};
