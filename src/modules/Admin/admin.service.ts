import { prisma } from "../../lib/prisma/prisma";
import { UpdateAdminPayload } from "./admin.interface";

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

const updateAdmin = async (userId: string, payload: UpdateAdminPayload) => {
    const { workLocations, ...adminData } = payload;

    return await prisma.$transaction(async (tx) => {
        const admin = await tx.adminProfile.findUnique({
            where: { userId },
        });

        if (!admin) {
            throw new Error("Admin profile not found");
        }

        let updatedAdmin = admin;

        // ✅ Only update if adminData has at least one field
        if (Object.keys(adminData).length > 0) {
            updatedAdmin = await tx.adminProfile.update({
                where: { userId },
                data: adminData,
            });
        }

        // ✅ Handle workLocations separately
        if (workLocations !== undefined) {
            await tx.workLocation.deleteMany({
                where: { adminId: admin.id },
            });

            if (workLocations.length > 0) {
                await tx.workLocation.createMany({
                    data: workLocations.map((loc) => ({
                        city: loc.city,
                        postcode: loc.postcode,
                        notes: loc.notes,
                        adminId: admin.id,
                    })),
                });
            }
        }

        // ✅ Return final state
        return await tx.adminProfile.findUnique({
            where: { userId },
            include: {
                workLocations: true,
            },
        });
    });
};

export const adminService = {
    createAdmin,
    updateAdmin,
};
