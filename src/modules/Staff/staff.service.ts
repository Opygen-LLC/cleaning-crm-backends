import { prisma } from "../../lib/prisma/prisma";
import { CreateStaffPayload, StaffFilterOptions, UpdateStaffPayload } from "./staff.interface";
import { UserRole } from "../../generated/prisma/enums";
import { auth } from "../../lib/auth";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

const createStaff = async (payload: CreateStaffPayload, adminUser: any) => {
    const { email, name, password, staffRole, mobileNumber } = payload;

    // 1. Get Admin Profile
    const adminProfile = await prisma.adminProfile.findFirst({
        where: { userId: adminUser.id }
    });

    if (!adminProfile) {
        throw new AppError(status.NOT_FOUND, "Admin profile not found");
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
        throw new AppError(status.BAD_REQUEST, "User with this email already exists");
    }

    // 2. Create User via better-auth (to handle hashing etc.)
    const signUpResult = await auth.api.signUpEmail({
        body: { 
            name, 
            email, 
            password: password || "123456",
        },
    });

    if (!signUpResult || !signUpResult.user) {
        throw new AppError(status.INTERNAL_SERVER_ERROR, "Failed to create user for staff");
    }

    const userId = signUpResult.user.id;

    // 3. Update user role to STAFF explicitly and activate status
    await prisma.user.update({
        where: { id: userId },
        data: { 
            role: UserRole.STAFF,
            emailVerified: true // Auto verify for staff created by admin
        }
    });

    // 4. Create StaffProfile
    const staffProfile = await prisma.staffProfile.create({
        data: {
            userId,
            adminId: adminProfile.id,
            staffRole,
            mobileNumber,
        },
        include: {
            user: true,
            admin: true
        }
    });

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
                { user: { name: { contains: searchTerm, mode: "insensitive" } } },
                { admin: { businessName: { contains: searchTerm, mode: "insensitive" } } }
            ]
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
        const adminProfile = await prisma.adminProfile.findUnique({ where: { userId: userReq.id } });
        if (adminProfile) {
            andConditions.push({ adminId: adminProfile.id });
        }
    } else if (userReq.role === UserRole.STAFF) {
        const staffProfile = await prisma.staffProfile.findUnique({ where: { userId: userReq.id } });
        if (staffProfile) {
            andConditions.push({ adminId: staffProfile.adminId });
        }
    }

    const whereConditions = andConditions.length > 0 ? { AND: andConditions } : {};

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
