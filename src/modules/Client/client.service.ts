import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { IRequestUser } from "../../types/requestUser.interface";
import { createClientPayload, updateClientPayload } from "./client.interface";
import { prisma } from "../../lib/prisma/prisma";
import { assertWithinLimit } from "../../lib/utils/checkPlanLimits";
import { IQueryParams } from "../../interface/query.interface";
import { Client, Prisma } from "../../generated/prisma/client";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { waitUntil } from "@vercel/functions";
import {
    clientFilterableFields,
    clientSearchableFields,
} from "./client.constant";
import { randomUUID } from "crypto";
import { requireE164Phone } from "../../lib/validation/phone";
import { serviceDisplayName } from "../../lib/utils/serviceIdentity";
import {
    buildAddressString,
    geocodeAddressSafely,
} from "../../lib/utils/geocoding";
import { clientDetailSelect, clientListSelect, clientLookupSelect, clientMutationSelect } from "./client.projection";
import { resolveCountryEnum } from "../../lib/constants/countryIsoMap";

/**
 * Geocodes the client's structured address into lat/lng. Never throws —
 * on failure this just resolves to `{}`, and the client is created/updated
 * without coordinates (dispatch proximity scoring skips it gracefully).
 */
const geocodeClientAddress = async (address: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    postcode?: string;
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

const scheduleClientGeocode = (clientId: string, address: Parameters<typeof geocodeClientAddress>[0]): void => {
    waitUntil(
        (async () => {
            const geo = await geocodeClientAddress(address);
            if (Object.keys(geo).length === 0) return;
            await prisma.client.update({ where: { id: clientId }, data: geo });
        })().catch(() => undefined),
    );
};

const createClient = async (
    payload: createClientPayload,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    // Enforce plan limits before inserting
    await assertWithinLimit(adminId, "client");

    const profile = await prisma.adminProfile.findUnique({
        where: { id: adminId },
        select: { country: true },
    });
    if (!profile?.country) {
        throw new AppError(status.CONFLICT, "Set the business country before adding clients.", {
            code: "BUSINESS_COUNTRY_REQUIRED",
            retryable: false,
            fieldErrors: { country: "Set the business country first." },
        });
    }
    const submittedCountry = resolveCountryEnum(payload.country);
    if (!submittedCountry || submittedCountry !== profile.country) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "Client country must match the registered business country.", {
            code: "CLIENT_COUNTRY_MISMATCH",
            retryable: false,
            fieldErrors: { country: "Clients must use the registered business country." },
        });
    }

    const { notes, servicePreference, email, phone, postcode, zipcode, ...rest } = payload;
    const canonicalPostcode = postcode ?? zipcode ?? "";
    const dbAddress = {
        ...rest,
        phone: requireE164Phone(phone),
        zipcode: canonicalPostcode,
    };

    const result = await prisma.client.upsert({
        where: {
            email_adminId: {
                email,
                adminId,
            },
        },
        create: {
            ...dbAddress,
            email,
            ...(servicePreference ? { servicePreference } : {}),
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
            ...dbAddress,
            ...(servicePreference ? { servicePreference } : {}),
            notes: notes
                ? {
                      create: {
                          text: notes,
                      },
                  }
                : undefined,
        },
        select: clientMutationSelect,
    });

    scheduleClientGeocode(result.id, dbAddress);
    return result;
};

const getClients = async (query: IQueryParams, user: IRequestUser) => {
    const adminId = await getAdminId(user);

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
        .select(clientListSelect)
        .paginate()
        .sort()
        .fields()
        .execute();

    return {
        ...result,
        data: result.data.map((client: any) => ({ ...client, postcode: client.zipcode ?? "" })),
    };
};

const getClientById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const client = await prisma.client.findUniqueOrThrow({
        where: { id, adminId },
        select: clientDetailSelect,
    });

    return { ...client, postcode: client.zipcode ?? "" };
};

const getClientLookup = async (query: IQueryParams, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const q = String(query.searchTerm ?? query.search ?? "").trim();
    const requestedLimit = Number(query.limit ?? 20);
    const limit = Math.min(25, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20));

    const rows = await prisma.client.findMany({
        where: {
            adminId,
            ...(q
                ? {
                      OR: [
                          { name: { contains: q, mode: "insensitive" } },
                          { email: { contains: q, mode: "insensitive" } },
                          { phone: { contains: q } },
                      ],
                  }
                : {}),
        },
        select: clientLookupSelect,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: limit,
    });

    return rows.map((client) => ({ ...client, postcode: client.zipcode ?? "" }));
};

const getClientBookingPrefill = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const client = await prisma.client.findFirst({
        where: { id, adminId },
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
        },
    });

    if (!client) {
        throw new AppError(status.NOT_FOUND, "Client not found", {
            code: "CLIENT_NOT_FOUND",
            retryable: false,
        });
    }

    return {
        id: client.id,
        name: client.name,
        email: client.email,
        phone: client.phone,
        address: {
            line1: client.addressLine1 ?? "",
            line2: client.addressLine2 ?? undefined,
            city: client.city ?? "",
            postcode: client.zipcode ?? "",
            country: client.country ?? undefined,
        },
    };
};

const updateClient = async (
    id: string,
    payload: updateClientPayload,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.client.findUnique({
        where: { id, adminId },
        select: {
            id: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            zipcode: true,
            country: true,
        },
    });

    if (!existing) throw new AppError(status.NOT_FOUND, "Client not found");

    const addressChanged =
        payload.addressLine1 !== undefined ||
        payload.addressLine2 !== undefined ||
        payload.city !== undefined ||
        payload.postcode !== undefined ||
        payload.zipcode !== undefined ||
        payload.country !== undefined;

    const { postcode, zipcode, phone, ...restPayload } = payload;
    const updated = await prisma.client.update({
        where: { id },
        data: {
            ...restPayload,
            ...(phone !== undefined ? { phone: requireE164Phone(phone) } : {}),
            ...(postcode !== undefined || zipcode !== undefined ? { zipcode: postcode ?? zipcode } : {}),
        },
        select: clientMutationSelect,
    });

    if (addressChanged) {
        scheduleClientGeocode(id, {
            addressLine1: payload.addressLine1 ?? existing.addressLine1,
            addressLine2: payload.addressLine2 ?? existing.addressLine2 ?? undefined,
            city: payload.city ?? existing.city,
            zipcode: payload.postcode ?? payload.zipcode ?? existing.zipcode,
            country: payload.country ?? existing.country,
        });
    }

    return updated;
};

const deleteClient = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.client.findUnique({
        where: { id, adminId },
        select: { id: true },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Client not found");
    }

    const deleted = await prisma.client.delete({ where: { id }, select: { id: true } });
    return { ...deleted, deleted: true };
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
                    serviceNameSnapshot: true,
                    serviceCatalog: { select: { id: true, serviceName: true } },
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

    const { zipcode: _legacyZipcode, ...portalClient } = client;
    return {
        ...portalClient,
        postcode: client.zipcode ?? "",
        bookings: client.bookings.map((booking) => ({
            ...booking,
            serviceName: serviceDisplayName(booking),
        })),
    };
};

// ─── Admin: regenerate portal access token ────────────────────────────────────
//
// Rotates the portalAccessToken to a fresh UUID.  The old link immediately
// stops working.  The response returns the new token so the admin can copy
// the new URL without refreshing.

const regeneratePortalToken = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

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
    getClientLookup,
    getClientById,
    getClientBookingPrefill,
    updateClient,
    deleteClient,
    getClientPortal,
    regeneratePortalToken,
};
