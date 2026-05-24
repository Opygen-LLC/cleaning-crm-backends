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
<<<<<<< HEAD
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
=======
  const adminProfile = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!adminProfile) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }
>>>>>>> 1b0a17fe2991b022e19bcb0b7ae1631b40cc1fb6

  return adminProfile.id;
};

<<<<<<< HEAD
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
=======
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
      ...(servicePreference ? { servicePreference } : {}),
      adminId,
>>>>>>> 1b0a17fe2991b022e19bcb0b7ae1631b40cc1fb6

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
<<<<<<< HEAD
    const adminId = await resolveAdminId(user.id);

    const client = await prisma.client.findUniqueOrThrow({
        where: { id, adminId },
        include: {
            notes: true,
            bookings: true,
        },
    });
=======
  const adminId = await resolveAdminId(user.id);
>>>>>>> 1b0a17fe2991b022e19bcb0b7ae1631b40cc1fb6

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
<<<<<<< HEAD
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.client.findUnique({
        where: { id, adminId },
    });
=======
  const existing = await prisma.client.findUnique({
    where: { id },
  });
>>>>>>> 1b0a17fe2991b022e19bcb0b7ae1631b40cc1fb6

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
<<<<<<< HEAD
    const adminId = await resolveAdminId(user.id);

    const existing = await prisma.client.findUnique({
        where: { id, adminId },
    });
=======
  const existing = await prisma.client.findUnique({
    where: { id },
  });
>>>>>>> 1b0a17fe2991b022e19bcb0b7ae1631b40cc1fb6

  if (!existing) {
    throw new AppError(status.NOT_FOUND, "Client not found");
  }

  return await prisma.client.delete({
    where: { id },
  });
};


const getClientPortal = async (clientId: string) => {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
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

export const clientService = {
  createClient,
  getClients,
  getClientById,
  updateClient,
  deleteClient,
  getClientPortal,
};
