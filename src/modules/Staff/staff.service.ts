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
import { geocodeAddressSafely } from "../../lib/utils/geocoding";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { revokeAllSessionsForUser } from "../Auth/sessionSecurity.service";
import { invalidateRuntimeAuth } from "../../lib/cache/authRuntimeCache";
import { normalizeOptionalE164Phone, requireE164Phone } from "../../lib/validation/phone";

/**
 * [Phase 2 — location-aware dispatch] Best-effort geocode of a staff
 * member's home/base address, so the dispatch engine can score proximity
 * to jobs. Never throws — staff creation/updates must succeed even if the
 * address can't be resolved.
 */
const geocodeStaffAddress = async (address: string | null | undefined) => {
    if (!address) return {};
    const geo = await geocodeAddressSafely(address);
    if (!geo) return {};
    return {
        latitude: geo.latitude,
        longitude: geo.longitude,
        geocodedAt: new Date(),
    };
};

const createStaff = async (payload: CreateStaffPayload, adminUser: IRequestUser) => {
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

    const adminId = await getAdminId(adminUser);

    await assertWithinLimit(adminId, "staff");

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
    } catch (err: unknown) {
        if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2002") {
            throw new AppError(status.BAD_REQUEST, "Email already exists");
        }
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
    const geo = await geocodeStaffAddress(address);

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
                adminId,
                staffRole: StaffRole,
                mobileNumber: requireE164Phone(mobileNumber, "mobileNumber"),
                address,
                ...geo,
                hourlyRate,
                startDate: new Date(startDate),
                specialty,
                emergencyName,
                emergencyMobileNumber: emergencyMobileNumber
                    ? requireE164Phone(emergencyMobileNumber, "emergencyMobileNumber")
                    : undefined,
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

const getMyStaff = async (query: IQueryParams, userReq: IRequestUser) => {
    const adminId = await getAdminId(userReq);

    const { role, status: statusParam, searchTerm, search } = query as IQueryParams & {
        role?: string;
        status?: string;
        search?: string;
    };

    const extraWhere: Prisma.StaffProfileWhereInput = {
        adminId,
    };

    if (statusParam && statusParam !== "All") {
        const formattedStatus = statusParam.toUpperCase().replace(/\s+/g, "_");
        if (formattedStatus === StaffStatus.INACTIVE) {
            extraWhere.status = StaffStatus.INACTIVE;
        } else if (formattedStatus === StaffStatus.ACTIVE) {
            extraWhere.status = StaffStatus.ACTIVE;
        } else if (formattedStatus === StaffStatus.ON_LEAVE) {
            extraWhere.status = StaffStatus.ON_LEAVE;
        }
    }

    if (role && role !== "All") {
        extraWhere.staffRole = role;
    }

    const q = (searchTerm || search)?.toString().trim();
    if (q) {
        extraWhere.OR = [
            { user: { name: { contains: q, mode: "insensitive" } } },
            { user: { email: { contains: q, mode: "insensitive" } } },
            { staffRole: { contains: q, mode: "insensitive" } },
        ];
    }

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
        .where(extraWhere)
        .include({ user: true, staffAvailability: true })
        .paginate()
        .sort()
        .fields()
        .execute();
};


const getStaffById = async (id: string, userReq: IRequestUser) => {
    if (userReq.role !== UserRole.ADMIN)
        throw new AppError(status.FORBIDDEN, "Forbidden");

    const adminId = await getAdminId(userReq);

    return prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId },
        include: { user: true, staffAvailability: true },
    });
};

const updateStaff = async (
    id: string,
    payload: UpdateStaffPayload,
    adminUser: IRequestUser,
) => {
    const adminId = await getAdminId(adminUser);

    const existing = await prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId },
    });

    const geo =
        payload.address !== undefined && payload.address !== existing.address
            ? await geocodeStaffAddress(payload.address)
            : {};

    return prisma.staffProfile.update({
        where: { id },
        data: { ...payload, ...geo },
    });
};

const deleteStaff = async (id: string, adminUser: IRequestUser) => {
    const adminId = await getAdminId(adminUser);

    await prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId },
    });
    return prisma.staffProfile.delete({ where: { id } });
};

/**
 * POST /staff/:id/reset-password
 *
 * Admin-triggered password reset for a staff member (e.g. they're locked
 * out and can't use the self-service "forgot password" OTP flow). Unlike
 * the OTP-based /auth/reset-password route, this doesn't require the staff
 * member to do anything first — the admin just clicks "Reset".
 *
 * We generate a new random password and write it via better-auth's
 * internal context (`auth.$context`) rather than `auth.api.signInEmail`/
 * `changePassword`, since neither of those fits: we don't have — and don't
 * want — the old password, and there's no admin plugin installed that
 * exposes a higher-level "set user password" endpoint. `ctx.password.hash`
 * + `ctx.internalAdapter.updatePassword` is the same primitive better-auth's
 * own password-reset routes use internally, so this stays consistent with
 * how a real reset is performed, just without requiring an OTP roundtrip.
 *
 * After the swap we:
 *  - flip needPasswordChange so the staff member is forced onto the
 *    set-password screen on next login (same flag used at staff creation),
 *  - revoke all of their existing sessions, since the old password (and
 *    therefore anyone who obtained it) should no longer have standing access,
 *  - email the new password so they can log back in.
 *
 * The generated password is never included in the API response — only the
 * staff member's inbox receives it.
 */
const resetStaffPassword = async (id: string, adminUser: IRequestUser) => {
    const adminId = await getAdminId(adminUser);

    const staffProfile = await prisma.staffProfile.findFirst({
        where: { id, adminId },
        include: { user: true },
    });
    if (!staffProfile)
        throw new AppError(status.NOT_FOUND, "Staff member not found");

    const newPassword = generateRandomPassword() ?? "Staff@123";

    const ctx = await auth.$context;
    const hashedPassword = await ctx.password.hash(newPassword);
    await ctx.internalAdapter.updatePassword(
        staffProfile.userId,
        hashedPassword,
    );

    await prisma.user.update({
        where: { id: staffProfile.userId },
        data: { needPasswordChange: true },
    });
    await revokeAllSessionsForUser(staffProfile.userId);
    invalidateRuntimeAuth(staffProfile.userId);

    waitUntil(
        sendEmailSafely({
            to: staffProfile.user.email,
            subject: "Your password has been reset",
            templateName: "staff-password-reset",
            templateData: {
                name: staffProfile.user.name,
                email: staffProfile.user.email,
                password: newPassword,
                loginUrl: `${process.env.FRONTEND_URL}/login`,
            },
        }),
    );

    return { success: true };
};

/**
 * upsertAvailability
 *
 * Shared by both the admin-facing updateAvailability() and the staff
 * self-service updateMyAvailability() below — both write the exact same
 * shape into StaffAvailability, they only differ in *who* is authorized
 * to call them and how the target staffId is resolved.
 */
const upsertAvailability = async (
    staffId: string,
    availability: UpdateAvailabilityPayload["availability"],
) => {
    const upserts = availability.map((item) =>
        prisma.staffAvailability.upsert({
            where: { staffId_day: { staffId, day: item.day } },
            update: {
                startTime: item.isActive ? (item.startTime ?? null) : null,
                endTime: item.isActive ? (item.endTime ?? null) : null,
                isActive: item.isActive ?? true,
            },
            create: {
                staffId,
                day: item.day,
                startTime: item.isActive ? (item.startTime ?? null) : null,
                endTime: item.isActive ? (item.endTime ?? null) : null,
                isActive: item.isActive ?? true,
            },
        }),
    );

    await prisma.$transaction(upserts);

    return prisma.staffProfile.findUniqueOrThrow({
        where: { id: staffId },
        include: { user: true, staffAvailability: true },
    });
};

const updateAvailability = async (
    id: string,
    payload: UpdateAvailabilityPayload,
    adminUser: IRequestUser,
) => {
    const adminId = await getAdminId(adminUser);

    await prisma.staffProfile.findUniqueOrThrow({
        where: { id, adminId },
    });

    return upsertAvailability(id, payload.availability);
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

    if (!profile)
        throw new AppError(status.NOT_FOUND, "Staff profile not found");

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
                        gte: new Date(
                            new Date().getFullYear(),
                            new Date().getMonth(),
                            1,
                        ),
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
    if (!profile)
        throw new AppError(status.NOT_FOUND, "Staff profile not found");

    const { name, ...rawProfileFields } = payload;
    const profileFields = {
        ...rawProfileFields,
        ...(rawProfileFields.mobileNumber !== undefined
            ? { mobileNumber: requireE164Phone(rawProfileFields.mobileNumber, "mobileNumber") }
            : {}),
        ...(rawProfileFields.emergencyMobileNumber !== undefined
            ? {
                  emergencyMobileNumber: normalizeOptionalE164Phone(
                      rawProfileFields.emergencyMobileNumber,
                      "emergencyMobileNumber",
                  ),
              }
            : {}),
    };

    const geo =
        profileFields.address !== undefined &&
        profileFields.address !== profile.address
            ? await geocodeStaffAddress(profileFields.address)
            : {};

    // Run user name update and profile update in parallel for speed
    await Promise.all([
        name
            ? prisma.user.update({ where: { id: userId }, data: { name } })
            : Promise.resolve(),
        Object.keys(profileFields).length > 0 || Object.keys(geo).length > 0
            ? prisma.staffProfile.update({
                  where: { id: profile.id },
                  data: { ...profileFields, ...geo },
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
    if (!profile)
        throw new AppError(status.NOT_FOUND, "Staff profile not found");

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

/**
 * PATCH /staff/me/availability
 *
 * Lets a staff member toggle their own weekly working-hours schedule
 * on/off (and edit start/end times) without needing an admin to do it
 * for them. Reuses the same upsert logic as the admin-facing
 * updateAvailability() above, scoped to the caller's own StaffProfile
 * instead of an :id route param — so a staff member can never touch
 * another staff member's schedule.
 *
 * Unlike the admin endpoint (which returns the raw StaffProfile row to
 * match the admin StaffMemberData shape), this returns the same curated
 * shape as getMyProfile()/updateMyProfile() — flattened fields plus
 * performance stats — since that's the MyStaffProfile contract the
 * staff profile page's RTK Query cache expects.
 */
const updateMyAvailability = async (
    userId: string,
    payload: UpdateAvailabilityPayload,
) => {
    const profile = await prisma.staffProfile.findFirst({ where: { userId } });
    if (!profile)
        throw new AppError(status.NOT_FOUND, "Staff profile not found");

    await upsertAvailability(profile.id, payload.availability);
    return getMyProfile(userId);
};

export const staffService = {
    createStaff,
    getMyStaff,
    getStaffById,
    updateStaff,
    deleteStaff,
    updateAvailability,
    resetStaffPassword,
    // New
    getMyProfile,
    updateMyProfile,
    uploadMyAvatar,
    updateMyAvailability,
};
