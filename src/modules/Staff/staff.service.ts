import { prisma } from "../../lib/prisma/prisma";
import { StaffFilterOptions, UpdateStaffPayload } from "./staff.interface";
import { UserRole } from "../../generated/prisma/enums";

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
    getMyProfile,
    getAllStaff,
    getStaffById,
    updateStaff,
    deleteStaff,
};
