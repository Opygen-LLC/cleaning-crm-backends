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

const createClient = async (
    payload: createClientPayload,
    user: IRequestUser,
) => {
    const { notes, servicePreference, email, ...rest } = payload;

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
            ...(servicePreference ? { servicePreference } : {}),
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
            ...(servicePreference ? { servicePreference } : {}),

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

const getClients = async (
    query: IQueryParams,
    user: IRequestUser,
) => {
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
        .where({ adminId: user.id })
        .include({ notes: true })
        .paginate()
        .sort()
        .fields()
        .execute();

    return result;
};

const getClientById = async (id: string, user: IRequestUser) => {
    const client = await prisma.client.findUniqueOrThrow({
        where: { id, adminId: user.id },
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
    const existing = await prisma.client.findUnique({
        where: { id },
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
    const existing = await prisma.client.findUnique({
        where: { id },
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
