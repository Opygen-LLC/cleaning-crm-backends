import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { IRequestUser } from "../../types/requestUser.interface";
import { createClientPayload, updateClientPayload } from "./client.interface";
import { prisma } from "../../lib/prisma/prisma";
import { IQueryParams } from "../../interface/query.interface";
import { Client, Prisma } from "../../generated/prisma/client";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { clientFilterableFields, clientSearchableFields } from "./client.constant";
import { UserRole } from "../../generated/prisma/enums";

// ─── Shared admin-profile resolver ────────────────────────────────────────────
// FIX #7: Extract shared helper so repeated callers don't each hit the DB;
//         each service method calls it once and passes the result around.

const resolveAdminProfile = async (user: IRequestUser) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    return adminProfile;
};

const createClient = async (
    adminId: string,
    payload: createClientPayload,
    user?: IRequestUser,
) => {
    if (user && user.role === UserRole.ADMIN) {
        const adminProfile = await resolveAdminProfile(user);

        if (adminProfile.id !== adminId) {
            throw new AppError(
                status.FORBIDDEN,
                "You are not allowed to create client for another admin.",
            );
        }
    }

    const { notes, servicePreference, email, ...rest } = payload;

    // FIX #5: Remove serviceCatalog validation on create — servicePreference is
    //         stored as a plain string; forcing a catalog lookup causes 404
    //         errors when the catalog is empty or the service name doesn't match
    //         exactly. The field is informational only.

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
            servicePreference,
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
            servicePreference,

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

const getClients = async (adminId: string, query: IQueryParams, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    if (adminProfile.id !== adminId) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to view clients for another admin.");
    }

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

    // FIX #6: Controller was sending `result` (IQueryResult) directly as
    //         `data`, producing { data: { data: [...], meta: {...} } }.
    //         Return the unwrapped shape so the controller can spread
    //         data and meta at the top level.
    return result;
};

const getClientById = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const client = await prisma.client.findUniqueOrThrow({
        where: { id, adminId: adminProfile.id },
        include: {
            notes: true,
            bookings: true,
        },
    });

    return client;
};

const updateClient = async (id: string, payload: updateClientPayload, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.client.findUnique({
        where: { id },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Client not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to update this client.");
    }

    // FIX #8: Remove serviceCatalog lookup on update — servicePreference is a
    //         free-text field; validating against the catalog breaks updates
    //         when the catalog is empty or the name changed since creation.
    // (Removed: prisma.serviceCatalog.findUniqueOrThrow block)

    return await prisma.client.update({
        where: { id },
        data: payload,
        include: { notes: true },
    });
};

const deleteClient = async (id: string, user: IRequestUser) => {
    const adminProfile = await resolveAdminProfile(user);

    const existing = await prisma.client.findUnique({
        where: { id },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Client not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to delete this client.");
    }

    return await prisma.client.delete({
        where: { id },
    });
};

export const clientService = {
    createClient,
    getClients,
    getClientById,
    updateClient,
    deleteClient,
};
