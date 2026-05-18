import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { IRequestUser } from "../../types/requestUser.interface";
import { createClientPayload, updateClientPayload } from "./client.interface";
import { prisma } from "../../lib/prisma/prisma";
import { IQueryParams } from "../../interface/query.interface";
import { Client, Prisma } from "../../generated/prisma/client";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { clientFilterableFields, clientSearchableFields } from "./client.constant";

const createClient = async (
    payload: createClientPayload,
    user: IRequestUser,
) => {
    const { notes, servicePreference, email, ...rest } = payload;

    // validate service exists
    await prisma.serviceCatalog.findUniqueOrThrow({
        where: {
            serviceName_adminId: {
                serviceName: servicePreference,
                adminId: user.id,
            },
        },
    });

    return await prisma.client.upsert({
        where: {
            email_adminId: {
                email,
                adminId: user.id,
            },
        },
        create: {
            ...rest,
            email,
            servicePreference,
            adminId: user.id,

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
    // Verify caller is the correct admin
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

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

    return result;
};

const getClientById = async (id: string, user: IRequestUser) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

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
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    // Ensure client belongs to this admin
    const existing = await prisma.client.findUnique({
        where: { id },
    });

    if (!existing) {
        throw new AppError(status.NOT_FOUND, "Client not found");
    }

    if (existing.adminId !== adminProfile.id) {
        throw new AppError(status.FORBIDDEN, "You are not allowed to update this client.");
    }

    if (payload.servicePreference) {
        await prisma.serviceCatalog.findUniqueOrThrow({
            where: {
                serviceName_adminId: {
                    serviceName: payload.servicePreference,
                    adminId: adminProfile.id,
                },
            },
        });
    }

    return await prisma.client.update({
        where: { id },
        data: payload,
        include: { notes: true },
    });
};

const deleteClient = async (id: string, user: IRequestUser) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: user.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

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
