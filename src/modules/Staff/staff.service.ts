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
import { uploadToCloudinary } from "../../lib/utils/cloudinary";

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

  const adminProfile = await prisma.adminProfile.findFirst({
    where: { userId: adminUser.id },
  });
  if (!adminProfile)
    throw new AppError(status.NOT_FOUND, "Admin profile not found");

  await assertWithinLimit(adminProfile.id, "staff");

  const password = generateRandomPassword() ?? "Staff@123";
  let userId: string;

  try {
    const signUpResult = await auth.api.signUpEmail({
      body: { name, email, password, role: UserRole.STAFF },
    });
    if (!signUpResult?.user) {
      throw new AppError(
        status.INTERNAL_SERVER_ERROR,
        "Failed to create user for staff",
      );
    }
    userId = signUpResult.user.id;
  } catch (err: any) {
    if (err?.code === "P2002")
      throw new AppError(status.BAD_REQUEST, "Email already exists");
    throw err;
  }

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

  const staffProfile = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        needPasswordChange: true,
        emailVerified: true,
        status: AccountStatus.ACTIVE,
      },
    });

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
          ? { create: availabilityData }
          : undefined,
      },
      include: { user: true, staffAvailability: true },
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
        password,
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
  if (!adminProfile)
    throw new AppError(status.NOT_FOUND, "Admin profile not found");

  const queryBuilder = new QueryBuilder<
    StaffProfile,
    Prisma.StaffProfileWhereInput,
    Prisma.StaffProfileInclude
  >(prisma.staffProfile, query, {
    searchableFields: staffSearchableFields,
    filterableFields: staffFilterableFields,
  });

  return queryBuilder
    .search()
    .filter()
    .where({ adminId: adminProfile.id })
    .include({ user: true, staffAvailability: true })
    .paginate()
    .sort()
    .fields()
    .execute();
};

const getStaffById = async (id: string, userReq: IRequestUser) => {
  if (userReq.role !== UserRole.ADMIN)
    throw new AppError(status.FORBIDDEN, "Forbidden");

  const adminProfile = await prisma.adminProfile.findFirst({
    where: { userId: userReq.id },
  });
  if (!adminProfile)
    throw new AppError(status.NOT_FOUND, "Admin profile not found");

  return prisma.staffProfile.findUniqueOrThrow({
    where: { id, adminId: adminProfile.id },
    include: { user: true, staffAvailability: true },
  });
};

const updateStaff = async (
  id: string,
  payload: UpdateStaffPayload,
  adminUser: IRequestUser,
) => {
  const adminProfile = await prisma.adminProfile.findFirst({
    where: { userId: adminUser.id },
  });
  if (!adminProfile)
    throw new AppError(status.NOT_FOUND, "Admin profile not found");

  await prisma.staffProfile.findUniqueOrThrow({
    where: { id, adminId: adminProfile.id },
  });
  return prisma.staffProfile.update({ where: { id }, data: payload });
};

const deleteStaff = async (id: string, adminUser: IRequestUser) => {
  const adminProfile = await prisma.adminProfile.findFirst({
    where: { userId: adminUser.id },
  });
  if (!adminProfile)
    throw new AppError(status.NOT_FOUND, "Admin profile not found");

  await prisma.staffProfile.findUniqueOrThrow({
    where: { id, adminId: adminProfile.id },
  });
  return prisma.staffProfile.delete({ where: { id } });
};

const updateAvailability = async (
  id: string,
  payload: UpdateAvailabilityPayload,
  adminUser: IRequestUser,
) => {
  const adminProfile = await prisma.adminProfile.findFirst({
    where: { userId: adminUser.id },
  });
  if (!adminProfile)
    throw new AppError(status.NOT_FOUND, "Admin profile not found");

  await prisma.staffProfile.findUniqueOrThrow({
    where: { id, adminId: adminProfile.id },
  });

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
  return prisma.staffProfile.findUniqueOrThrow({
    where: { id },
    include: { user: true, staffAvailability: true },
  });
};

// ─── NEW: Staff self-service profile endpoints ────────────────────────────────

/**
 * GET /staff/me
 *
 * Returns the logged-in staff member's own profile, including their
 * availability schedule. Used by StaffProfilePage to populate all fields.
 */
const getMyProfile = async (userId: string) => {
  const profile = await prisma.staffProfile.findFirst({
    where: { userId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          createdAt: true,
        },
      },
      staffAvailability: {
        orderBy: { day: "asc" },
      },
    },
  });

  if (!profile) throw new AppError(status.NOT_FOUND, "Staff profile not found");

  // Count completed jobs and compute avg rating
  const [jobsCompleted, jobsThisMonth, reviewData] = await Promise.all([
    prisma.jobStaffAssignment.count({
      where: { staffId: profile.id, job: { status: "COMPLETED" } },
    }),
    prisma.jobStaffAssignment.count({
      where: {
        staffId: profile.id,
        job: {
          status: "COMPLETED",
          updatedAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
          },
        },
      },
    }),
    prisma.review.aggregate({
      where: { staffId: profile.id },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  // Hours this month from completed check-out records
  const thisMonthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  );
  const hoursThisMonthAgg = await prisma.jobStaffAssignment.aggregate({
    where: {
      staffId: profile.id,
      checkOutAt: { gte: thisMonthStart },
      hoursWorked: { not: null },
    },
    _sum: { hoursWorked: true },
  });

  return {
    id: profile.id,
    name: profile.user.name,
    email: profile.user.email,
    avatarUrl: profile.user.image,
    staffRole: profile.staffRole,
    mobileNumber: profile.mobileNumber,
    address: profile.address,
    emergencyName: profile.emergencyName,
    emergencyMobileNumber: profile.emergencyMobileNumber,
    specialty: profile.specialty,
    status: profile.status,
    startDate: profile.startDate,
    adminId: profile.adminId,
    staffAvailability: profile.staffAvailability,
    // Performance summary
    jobsCompleted,
    jobsThisMonth,
    avgRating: Number((reviewData._avg.rating ?? 0).toFixed(1)),
    reviewCount: reviewData._count.rating,
    hoursThisMonth: Number(
      (hoursThisMonthAgg._sum.hoursWorked ?? 0).toFixed(1),
    ),
    joinedDate: profile.user.createdAt,
  };
};

/**
 * PATCH /staff/me
 *
 * Staff members can update their own name, mobileNumber, address,
 * emergencyName, and emergencyMobileNumber. Email is read-only.
 * Avatar upload is handled separately via POST /staff/me/avatar.
 */
const updateMyProfile = async (
  userId: string,
  payload: {
    name?: string;
    mobileNumber?: string;
    address?: string;
    emergencyName?: string;
    emergencyMobileNumber?: string;
  },
) => {
  const profile = await prisma.staffProfile.findFirst({ where: { userId } });
  if (!profile) throw new AppError(status.NOT_FOUND, "Staff profile not found");

  const { name, ...profileFields } = payload;

  // Run user name update and profile update in parallel for speed
  await Promise.all([
    name
      ? prisma.user.update({ where: { id: userId }, data: { name } })
      : Promise.resolve(),
    Object.keys(profileFields).length > 0
      ? prisma.staffProfile.update({
          where: { id: profile.id },
          data: profileFields,
        })
      : Promise.resolve(),
  ]);

  return getMyProfile(userId);
};

/**
 * POST /staff/me/avatar
 *
 * Staff members can upload a profile photo. The file buffer is streamed
 * to Cloudinary under the "opygen/staff-avatars" folder and the resulting
 * secure_url is saved to user.image. Returns the new avatar URL.
 */
const uploadMyAvatar = async (
  userId: string,
  fileBuffer: Buffer,
  mimeType: string,
) => {
  const profile = await prisma.staffProfile.findFirst({ where: { userId } });
  if (!profile) throw new AppError(status.NOT_FOUND, "Staff profile not found");

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowedTypes.includes(mimeType)) {
    throw new AppError(
      status.BAD_REQUEST,
      "Only JPEG, PNG, WEBP, and GIF images are allowed",
    );
  }

  const result = await uploadToCloudinary(fileBuffer, {
    folder: "opygen/staff-avatars",
    public_id: `staff_${profile.id}`,
    overwrite: true,
    transformation: [
      { width: 400, height: 400, crop: "fill", gravity: "face" },
      { quality: "auto" },
    ],
  });

  await prisma.user.update({
    where: { id: userId },
    data: { image: result.secure_url },
  });

  return { avatarUrl: result.secure_url as string };
};

export const staffService = {
  createStaff,
  getMyStaff,
  getStaffById,
  updateStaff,
  deleteStaff,
  updateAvailability,
  // New
  getMyProfile,
  updateMyProfile,
  uploadMyAvatar,
};
