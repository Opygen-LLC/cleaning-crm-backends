import { prisma } from "../../lib/prisma/prisma";
import { UpdateUserPayload } from "./user.interface";

const getMe = async (userId: string) => {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            admin: true,
            staff: true,
        }
    });
    if (!user) {
        throw new Error("User not found");
    }
    return user;
};

const getAllUsers = async () => {
    return await prisma.user.findMany({
        include: {
            admin: true,
            staff: true,
        }
    });
};

const getUserById = async (id: string) => {
    const user = await prisma.user.findUnique({
        where: { id },
        include: {
            admin: true,
            staff: true,
        }
    });
    if (!user) {
        throw new Error("User not found");
    }
    return user;
};

const updateUser = async (id: string, payload: UpdateUserPayload) => {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
        throw new Error("User not found");
    }

    return await prisma.user.update({
        where: { id },
        data: payload,
    });
};

export const userService = {
    getMe,
    getAllUsers,
    getUserById,
    updateUser,
};
