import { deleteFileFromCloudinary } from "../../config/cloudinary";
import { prisma } from "../../lib/prisma/prisma";
import {
    UpdateAdminPayload,
    UpdateWorkLocationPayload,
} from "./admin.interface";

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

const getAdmin = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
        include: {
            workLocations: true,
        },
    });

    if (!admin) {
        throw new Error("Admin profile not found");
    }

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

const updateWorkLocation = async (
    userId: string,
    locationId: string,
    payload: UpdateWorkLocationPayload,
) => {
    return await prisma.$transaction(async (tx) => {
        const admin = await tx.adminProfile.findUnique({
            where: { userId },
        });

        if (!admin) {
            throw new Error("Admin profile not found");
        }

        const workLocation = await tx.workLocation.findFirst({
            where: {
                id: locationId,
                adminId: admin.id,
            },
        });

        if (!workLocation) {
            throw new Error("Work location not found");
        }

        return await tx.workLocation.update({
            where: { id: locationId },
            data: payload,
        });
    });
};

const deleteWorkLocation = async (userId: string, locationId: string) => {
    return await prisma.$transaction(async (tx) => {
        const admin = await tx.adminProfile.findUnique({
            where: { userId },
        });

        if (!admin) {
            throw new Error("Admin profile not found");
        }

        const workLocation = await tx.workLocation.findFirst({
            where: {
                id: locationId,
                adminId: admin.id,
            },
        });

        if (!workLocation) {
            throw new Error("Work location not found");
        }

        return await tx.workLocation.delete({
            where: { id: locationId },
        });
    });
};

// ─── Get admin usage counts (staff / clients / bookings this month) ───────────

const getAdminUsage = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
        select: { id: true },
    });

    if (!admin) {
        throw new Error("Admin profile not found");
    }

    const adminId = admin.id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [staffCount, clientCount, bookingCountThisMonth] = await Promise.all([
        prisma.staffProfile.count({
            where: { adminId, status: "ACTIVE" },
        }),
        prisma.client.count({
            where: { adminId, status: "ACTIVE" },
        }),
        prisma.booking.count({
            where: { adminId, createdAt: { gte: monthStart } },
        }),
    ]);

    return { staffCount, clientCount, bookingCountThisMonth };
};

// ─── Guided setup wizard status ────────────────────────────────────────────────
//
// Steps are auto-detected from real data — a step is "completed" once the
// corresponding record(s) actually exist, not from a manually-ticked flag.
// This means admins who already had data before this feature shipped skip
// straight past whichever steps they'd already done.
//
// Once every step is satisfied we stamp `onboardingCompletedAt` so a step
// can never "un-complete" itself later (e.g. if the admin deletes their only
// client) and force the wizard to reappear.

const ONBOARDING_STEPS = [
    { key: "business_profile", label: "Business Profile" },
    { key: "service", label: "Add a Service" },
    { key: "service_area", label: "Service Area" },
    { key: "team", label: "Invite Your Team" },
    { key: "client", label: "Add a Client" },
    { key: "booking", label: "Create a Booking" },
] as const;

const getOnboardingStatus = async (userId: string) => {
    const admin = await prisma.adminProfile.findUnique({
        where: { userId },
    });

    if (!admin) {
        throw new Error("Admin profile not found");
    }

    // Already fully completed previously — short-circuit, no need to recount
    // and no risk of a later data change (e.g. a deleted client) reopening it.
    if (admin.onboardingCompletedAt) {
        return {
            isComplete: true,
            completedCount: ONBOARDING_STEPS.length,
            totalCount: ONBOARDING_STEPS.length,
            steps: ONBOARDING_STEPS.map((s) => ({ ...s, completed: true })),
        };
    }

    const adminId = admin.id;

    const [
        serviceCount,
        workLocationCount,
        staffCount,
        clientCount,
        bookingCount,
    ] = await Promise.all([
        prisma.serviceCatalog.count({ where: { adminId } }),
        prisma.workLocation.count({ where: { adminId } }),
        prisma.staffProfile.count({ where: { adminId } }),
        prisma.client.count({ where: { adminId } }),
        prisma.booking.count({ where: { adminId } }),
    ]);

    const completedByKey: Record<
        (typeof ONBOARDING_STEPS)[number]["key"],
        boolean
    > = {
        business_profile: Boolean(
            admin.address &&
            admin.city &&
            admin.mobileNumber &&
            admin.businessType,
        ),
        service: serviceCount > 0,
        service_area: workLocationCount > 0,
        team: staffCount > 0,
        client: clientCount > 0,
        booking: bookingCount > 0,
    };

    const steps = ONBOARDING_STEPS.map((s) => ({
        ...s,
        completed: completedByKey[s.key],
    }));

    const completedCount = steps.filter((s) => s.completed).length;
    const isComplete = completedCount === steps.length;

    if (isComplete) {
        await prisma.adminProfile.update({
            where: { id: adminId },
            data: { onboardingCompletedAt: new Date() },
        });
    }

    return {
        isComplete,
        completedCount,
        totalCount: steps.length,
        steps,
    };
};

export const adminService = {
    createAdmin,
    getAdmin,
    updateAdmin,
    updateWorkLocation,
    deleteWorkLocation,
    getAdminUsage,
    getOnboardingStatus,
};
