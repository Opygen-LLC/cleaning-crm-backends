import { prisma } from "../../lib/prisma/prisma";

const createAdmin = async (payload: {
    userId: string;
    businessName: string;
}) => {
    const { userId, businessName } = payload;

    const existing = await prisma.adminProfile.findUnique({
        where: { userId },
    });

    if (existing) {
        throw new Error("Admin already exists");
    }

    const admin = await prisma.adminProfile.create({
        data: {
            businessName,
            userId,
        },
    });

	//? Subscription trial for 15 days

    return admin;
};

export const adminService = {
    createAdmin,
};
