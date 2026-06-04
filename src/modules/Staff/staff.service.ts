import { prisma } from "../../lib/prisma/prisma";
import { CreateStaffPayload, UpdateStaffPayload } from "./staff.interface";
import {
    AccountStatus,
    StaffStatus,
    UserRole,
} from "../../generated/prisma/enums";
import { auth } from "../../lib/auth";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { generateRandomPassword } from "../../lib/utils/generateRandomPassword";
import { changePassword } from "better-auth/api";
import { waitUntil } from "@vercel/functions";
import { sendEmail } from "../../lib/email";
import chalk from "chalk";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { IQueryParams } from "../../interface/query.interface";
import { Prisma, StaffProfile } from "../../generated/prisma/client";
import { staffFilterableFields, staffSearchableFields } from "./staff.constant";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IRequestUser } from "../../types/requestUser.interface";

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

    // 2. Generate password early (no DB cost dependency)
    const password = generateRandomPassword() ?? "Staff@123";

    let userId: string;

    try {
        // 3. Create user in auth system (external call = expensive)
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

    // 4. Prepare availability (safe + lightweight)
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

    // 5. DB operations in transaction (atomic + faster consistency)
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
        // .dynamicInclude(doctorIncludeConfig)
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

const updateStaff = async (id: string, payload: UpdateStaffPayload) => {
    const staff = await prisma.staffProfile.findUnique({ where: { id } });
    if (!staff) throw new Error("Staff profile not found");

    return await prisma.staffProfile.update({
        where: { id },
        data: payload,
    });
};

const deleteStaff = async (id: string) => {
    const staff = await prisma.staffProfile.findUnique({ where: { id } });
    if (!staff) throw new Error("Staff profile not found");

    return await prisma.staffProfile.delete({
        where: { id },
    });
};

export const staffService = {
    createStaff,
    getMyStaff,
    getStaffById,
    updateStaff,
    deleteStaff,
};
