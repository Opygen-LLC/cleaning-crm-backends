import { prisma } from "../../lib/prisma/prisma";
import {
    CreateStaffPayload,
    UpdateAvailabilityPayload,
    UpdateStaffPayload,
} from "./staff.interface";
import {
    AccountStatus,
    StaffStatus,
    UserRole,
} from "../../generated/prisma/enums";
import { auth } from "../../lib/auth";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { generateRandomPassword } from "../../lib/utils/generateRandomPassword";
import { waitUntil } from "@vercel/functions";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { IQueryParams } from "../../interface/query.interface";
import { Prisma, StaffProfile } from "../../generated/prisma/client";
import { staffFilterableFields, staffSearchableFields } from "./staff.constant";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IRequestUser } from "../../types/requestUser.interface";
import { assertWithinLimit } from "../../lib/utils/checkPlanLimits";

const createStaff = async (payload: CreateStaffPayload, adminUser: any) => {
    const {
        name,
        email,
        staffRole,
        mobileNumber,
        address,
        hourlyRate,
        startDate,
        specialty,
        emergencyName,
        emergencyMobileNumber,
        adminNote,
        staffAvailability,
    } = payload;

    // 1. Validate Admin Profile (fast DB check)
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: adminUser.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    // 2. Check plan limits before creating
    await assertWithinLimit(adminProfile.id, "staff");

    // 3. Generate password early (no DB cost dependency)
    const password = generateRandomPassword() ?? "Staff@123";

    let userId: string;

    try {
        // 4. Create user in auth system (external call = expensive)
        const signUpResult = await auth.api.signUpEmail({
            body: {
                name,
                email,
                password,
                role: UserRole.STAFF,
            },
        });

        if (!signUpResult?.user) {
            throw new AppError(
                status.INTERNAL_SERVER_ERROR,
                "Failed to create user for staff",
            );
        }

        userId = signUpResult.user.id;
    } catch (err: any) {
        // Handle duplicate email or auth errors safely
        if (err?.code === "P2002") {
            throw new AppError(status.BAD_REQUEST, "Email already exists");
        }
        throw err;
    }

    // 5. Prepare availability (safe + lightweight)
    const availabilityData =
        staffAvailability?.length > 0
            ? staffAvailability.map((item) => ({
                  day: item.day,
                  startTime: item.isActive ? item.startTime : null,
                  endTime: item.isActive ? item.endTime : null,
                  isActive: item.isActive ?? true,
              }))
            : [];

    const StaffRole = staffRole.toUpperCase();

    // 6. DB operations in transaction (atomic + faster consistency)
    const staffProfile = await prisma.$transaction(async (tx) => {
        // Update user metadata
        await tx.user.update({
            where: { id: userId },
            data: {
                needPasswordChange: true,
                emailVerified: true,
                status: AccountStatus.ACTIVE,
            },
        });

        // Create staff profile
        return tx.staffProfile.create({
            data: {
                userId,
                adminId: adminProfile.id,
                staffRole: StaffRole,

                mobileNumber,
                address,
                hourlyRate,
                startDate: new Date(startDate),
                specialty,

                emergencyName,
                emergencyMobileNumber,
                adminNote,

                staffAvailability: availabilityData.length
                    ? {
                          create: availabilityData,
                      }
                    : undefined,
            },
            include: {
                user: true,
                staffAvailability: true,
            },
        });
    });

    waitUntil(
        sendEmailSafely({
            to: email,
            subject: "Staff Account Created",
            templateName: "staff-create",
            templateData: {
                name: staffProfile.user.name,
                email: staffProfile.user.email,
                password: password,
                loginUrl: `${process.env.FRONTEND_URL}/login`,
            },
        }),
    );

    return staffProfile;
};

const getMyStaff = async (query: IQueryParams, userReq: any) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: userReq.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    const queryBuilder = new QueryBuilder<
        StaffProfile,
        Prisma.StaffProfileWhereInput,
        Prisma.StaffProfileInclude
    >(prisma.staffProfile, query, {
        searchableFields: staffSearchableFields,
        filterableFields: staffFilterableFields,
    });

    const result = await queryBuilder
        .search()
        .filter()
        .where({ adminId: adminProfile.id })
        .include({
            user: true,
            staffAvailability: true,
        })
        .paginate()
        .sort()
        .fields()
        .execute();

    return result;
};

const getStaffById = async (id: string, userReq: IRequestUser) => {
    if (userReq.role !== UserRole.ADMIN) {
        throw new AppError(status.FORBIDDEN, "Forbidden");
    }

    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: userReq.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    const staff = await prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId: adminProfile.id },
        include: {
            user: true,
            staffAvailability: true,
        },
    });

    return staff;
};

// FIX: Accept adminUser and scope lookups + updates to that tenant's adminId
const updateStaff = async (
    id: string,
    payload: UpdateStaffPayload,
    adminUser: IRequestUser,
) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: adminUser.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    // Scope the lookup to the tenant — prevents cross-tenant mutation
    await prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId: adminProfile.id },
    });

    return prisma.staffProfile.update({ where: { id }, data: payload });
};

// FIX: Accept adminUser and scope the delete to that tenant's adminId
const deleteStaff = async (id: string, adminUser: IRequestUser) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: adminUser.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    // Scope the lookup to the tenant — prevents cross-tenant deletion
    await prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId: adminProfile.id },
    });

    return prisma.staffProfile.delete({ where: { id } });
};

/**
 * Replace all 7 availability rows for a staff member in a single transaction.
 * Uses upsert so the endpoint is idempotent — safe to call repeatedly.
 */
const updateAvailability = async (
    id: string,
    payload: UpdateAvailabilityPayload,
    adminUser: IRequestUser,
) => {
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: adminUser.id },
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    // Tenant isolation: ensure the staff member belongs to this admin
    await prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId: adminProfile.id },
    });

    // Upsert each day — @@unique([staffId, day]) makes this safe
    const upserts = payload.availability.map((item) =>
        prisma.staffAvailability.upsert({
            where: { staffId_day: { staffId: id, day: item.day } },
            update: {
                startTime: item.isActive ? (item.startTime ?? null) : null,
                endTime: item.isActive ? (item.endTime ?? null) : null,
                isActive: item.isActive ?? true,
            },
            create: {
                staffId: id,
                day: item.day,
                startTime: item.isActive ? (item.startTime ?? null) : null,
                endTime: item.isActive ? (item.endTime ?? null) : null,
                isActive: item.isActive ?? true,
            },
        }),
    );

    await prisma.$transaction(upserts);

    // Return updated staff profile with fresh availability
    return prisma.staffProfile.findUniqueOrThrow({
        where: { id },
        include: { user: true, staffAvailability: true },
    });
};

export const staffService = {
    createStaff,
    getMyStaff,
    getStaffById,
    updateStaff,
    deleteStaff,
    updateAvailability,
};
