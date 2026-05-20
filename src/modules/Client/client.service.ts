import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { IRequestUser } from "../../types/requestUser.interface";
import { createClientPayload, updateClientPayload } from "./client.interface";
import { prisma } from "../../lib/prisma/prisma";
import { IQueryParams } from "../../interface/query.interface";
import { Client, Prisma } from "../../generated/prisma/client";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import {
    clientFilterableFields,
    clientSearchableFields,
} from "./client.constant";

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

const createClient = async (
    payload: createClientPayload,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);
    const { notes, servicePreference, email, ...rest } = payload;

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
            notes: true,
            bookings: true,
        },
    });

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

    return await prisma.client.update({
        where: { id },
        data: payload,
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

export const clientService = {
    createClient,
    getClients,
    getClientById,
    updateClient,
    deleteClient,
};
