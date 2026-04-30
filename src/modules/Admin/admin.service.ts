import { deleteFileFromCloudinary } from "../../config/cloudinary";
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

        const cleanAdminData = Object.fromEntries(
            Object.entries(adminData).filter(([_, v]) => v !== undefined),
        );

        if (adminData.businessLogo && admin.businessLogo) {
            await deleteFileFromCloudinary(admin.businessLogo);
        }

        // ✅ Only update if adminData has at least one field
        if (Object.keys(cleanAdminData).length > 0) {
            updatedAdmin = await tx.adminProfile.update({
                where: { userId },
                data: cleanAdminData,
            });
        }

        // ✅ Handle workLocations separately
        if (workLocations?.length) {
            const existingLocations = await tx.workLocation.findMany({
                where: {
                    adminId: admin.id,
                    city: { in: workLocations.map((loc) => loc.city) },
                },
            });

            // Get existing city names
            const existingCities = new Set(
                existingLocations.map((loc) => loc.city),
            );

            // Filter only new cities
            const newLocations = workLocations.filter(
                (loc) => !existingCities.has(loc.city),
            );

            // Create only non-existing ones
            if (newLocations.length) {
                await tx.workLocation.createMany({
                    data: newLocations.map((loc) => ({
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
