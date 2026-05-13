import { IRequestUser } from "../../types/requestUser.interface";
import { createClientPayload } from "./client.interface";
import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";

const createClient = async (
    payload: createClientPayload,
    user: IRequestUser,
) => {
    const { notes, servicePreference, email, ...rest } = payload;

    // validate service exists
    const service = await prisma.serviceCatalog.findUnique({
        where: {
            serviceName_adminId: {
                serviceName: servicePreference,
                adminId: user.id,
            },
        },
    });

    if (!service) {
        throw new AppError(400, "Service not found");
    }

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

export const clientService = {
    createClient,
};
