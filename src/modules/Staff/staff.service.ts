import { prisma } from "../../lib/prisma/prisma";
import {
    CreateStaffPayload,
    StaffFilterOptions,
    UpdateStaffPayload,
} from "./staff.interface";
import { UserRole } from "../../generated/prisma/enums";
import { auth } from "../../lib/auth";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { generateRandomPassword } from "../../lib/utils/generateRandomPassword";
import { changePassword } from "better-auth/api";
import { waitUntil } from "@vercel/functions";
import { sendEmail } from "../../lib/email";
import chalk from "chalk";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";

// const createStaff = async (payload: CreateStaffPayload, adminUser: any) => {
//     const {
//         name,
//         email,
//         staffRole,
//         mobileNumber,
//         address,
//         hourlyRate,
//         startDate,
//         specialty,
//         emergencyName,
//         emergencyMobileNumber,
//         adminNote,
//         staffAvailability,
//     } = payload;

//     // 1. Get Admin Profile
//     const adminProfile = await prisma.adminProfile.findFirst({
//         where: { userId: adminUser.id },
//     });

//     if (!adminProfile) {
//         throw new AppError(status.NOT_FOUND, "Admin profile not found");
//     }

//     // 2. Check existing user
//     const existingUser = await prisma.user.findUnique({
//         where: { email },
//     });

//     if (existingUser) {
//         throw new AppError(
//             status.BAD_REQUEST,
//             "User with this email already exists",
//         );
//     }

//     const password = generateRandomPassword() ?? "Staff@123";

//     // 3. Create User (auth system)
//     const signUpResult = await auth.api.signUpEmail({
//         body: {
//             name,
//             email,
//             password: password,
//         },
//     });

//     if (!signUpResult?.user) {
//         throw new AppError(
//             status.INTERNAL_SERVER_ERROR,
//             "Failed to create user for staff",
//         );
//     }

//     const userId = signUpResult.user.id;

//     // 4. Update user meta
//     await prisma.user.update({
//         where: { id: userId },
//         data: {
//             role: UserRole.STAFF,
//             needPasswordChange: true,
//             emailVerified: true,
//         },
//     });

//     // 5. Prepare availability data
//     const availabilityData = staffAvailability?.map((item) => ({
//         day: item.day,
//         startTime: item.isActive ? item.startTime : null,
//         endTime: item.isActive ? item.endTime : null,
//         isActive: item.isActive ?? true,
//     }));

//     // 6. Create StaffProfile + Availability (nested)
//     const staffProfile = await prisma.staffProfile.create({
//         data: {
//             userId,
//             adminId: adminProfile.id,
//             staffRole,

//             mobileNumber,
//             address,
//             hourlyRate,
//             startDate: startDate,
//             specialty,

//             emergencyName,
//             emergencyMobileNumber,
//             adminNote,

//             staffAvailability: {
//                 create: availabilityData,
//             },
//         },
//         include: {
//             user: true,
//             admin: true,
//             staffAvailability: true,
//         },
//     });

//     return staffProfile;
// };

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

    // 5. DB operations in transaction (atomic + faster consistency)
    const staffProfile = await prisma.$transaction(async (tx) => {
        // Update user metadata
        await tx.user.update({
            where: { id: userId },
            data: {
                needPasswordChange: true,
                emailVerified: true,
                status: "ACTIVE",
            },
        });

        // Create staff profile
        return tx.staffProfile.create({
            data: {
                userId,
                adminId: adminProfile.id,
                staffRole,

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

const getMyProfile = async (userId: string) => {
    const staff = await prisma.staffProfile.findUnique({
        where: { userId },
        include: { user: true, admin: true },
    });
    if (!staff) throw new Error("Staff profile not found");
    return staff;
};

const getAllStaff = async (filters: StaffFilterOptions, userReq: any) => {
    const { searchTerm, adminId, staffRole } = filters;
    const andConditions: any[] = [];

    if (searchTerm) {
        andConditions.push({
            OR: [
                {
                    user: {
                        name: { contains: searchTerm, mode: "insensitive" },
                    },
                },
                {
                    admin: {
                        businessName: {
                            contains: searchTerm,
                            mode: "insensitive",
                        },
                    },
                },
            ],
        });
    }

    if (adminId) {
        andConditions.push({ adminId });
    }

    if (staffRole) {
        andConditions.push({ staffRole });
    }

    // If Admin is requesting, restrict to their own adminId
    if (userReq.role === UserRole.ADMIN) {
        const adminProfile = await prisma.adminProfile.findUnique({
            where: { userId: userReq.id },
        });
        if (adminProfile) {
            andConditions.push({ adminId: adminProfile.id });
        }
    } else if (userReq.role === UserRole.STAFF) {
        const staffProfile = await prisma.staffProfile.findUnique({
            where: { userId: userReq.id },
        });
        if (staffProfile) {
            andConditions.push({ adminId: staffProfile.adminId });
        }
    }

    const whereConditions =
        andConditions.length > 0 ? { AND: andConditions } : {};

    return await prisma.staffProfile.findMany({
        where: whereConditions,
        include: { user: true, admin: true },
    });
};

const getStaffById = async (id: string) => {
    const staff = await prisma.staffProfile.findUnique({
        where: { id },
        include: { user: true, admin: true },
    });
    if (!staff) throw new Error("Staff profile not found");
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
    getMyProfile,
    getAllStaff,
    getStaffById,
    updateStaff,
    deleteStaff,
};
