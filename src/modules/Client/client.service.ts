import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { IRequestUser } from "../../types/requestUser.interface";
import { createClientPayload } from "./client.interface";
import { prisma } from "../../lib/prisma/prisma";

const createClient = async (
    adminId: string,
    payload: createClientPayload,
    user?: IRequestUser,
) => {
    if (user && user.id !== adminId) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not allowed to create client.",
        );
    }

    const { notes, servicePreference, email, ...rest } = payload;

    // validate service exists
    await prisma.serviceCatalog.findUniqueOrThrow({
        where: {
            serviceName_adminId: {
                serviceName: servicePreference,
                adminId,
            },
        },
    });

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

export const clientService = {
    createClient,
};
