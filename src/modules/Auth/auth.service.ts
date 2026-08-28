import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import {
    IRegisterUserPayload,
    ILoginUserPayload,
    IChangePasswordPayload,
} from "./auth.interface";
import { auth } from "../../lib/auth";
import { tokenUtils } from "../../lib/utils/token";
import { IRequestUser } from "../../types/requestUser.interface";
import { JwtPayload } from "jsonwebtoken";
import { jwtUtils } from "../../lib/utils/jwt";
import { REFRESH_TOKEN_SECRET } from "../../config/ENV";
import {
    AccountStatus,
    StaffStatus,
    SubscriptionStatus,
    UserRole,
} from "../../generated/prisma/enums";
import { AccountProvisioningService } from "./accountProvisioning.service";
import { getPlatformConfig } from "../../lib/utils/platformConfig";
import { AuthEmailOutbox } from "../../lib/outbox/authEmailOutbox";

//? Max sessions per user
const MAX_SESSIONS = 3;

/**
 * Registration has one canonical persistence path: AccountProvisioningService.
 * That service creates the Better Auth credential user/account, tenant profile,
 * website/pages/revision, trial and verification-email outbox row in one Prisma
 * transaction. No Better Auth sign-up call or compensating delete happens here.
 */
const register = async ({
    businessName,
    name,
    email,
    password,
    mobileNumber,
    businessType,
    licenseNumber,
}: IRegisterUserPayload) => {
    const platformConfig = await getPlatformConfig();
    if (!platformConfig.registrationOpen) {
        throw new AppError(
            status.FORBIDDEN,
            "New registrations are currently closed. Please contact support.",
        );
    }

    return AccountProvisioningService.provisionRegisteredAdmin({
        businessName,
        name,
        email,
        password,
        trialDays: platformConfig.defaultTrialDays,
        // Optional 2-step wizard fields — undefined if not provided
        mobileNumber,
        businessType,
        licenseNumber,
    });
};

const login = async ({ email, password }: ILoginUserPayload) => {
    // ✅ Minimal select — also fetch needPasswordChange so the client can
    //    redirect staff to the forced password-change screen on first login.
    const user = await prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
            role: true,
            needPasswordChange: true,          // ← added
            staff: { select: { status: true } },
            admin: { select: { onboardingCompletedAt: true } },
        },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    if (
        user.role === UserRole.STAFF &&
        user.staff?.status === StaffStatus.DEACTIVE
    ) {
        throw new AppError(
            status.FORBIDDEN,
            "You are not allowed to login. Please contact with admin.",
        );
    }

    // ✅ signInEmail includes password verification (scrypt) — but we can run session cleanup
    //    concurrently AFTER we know the user is valid, not after signIn resolves
    const signIn = await auth.api.signInEmail({
        body: { email, password },
    });

    if (!signIn.user.emailVerified) {
        return { data: signIn, accessToken: null, refreshToken: null };
    }

    // ✅ Let DB do the counting + deleting instead of fetching all rows into JS
    const sessionCount = await prisma.session.count({
        where: { userId: signIn.user.id },
    });

    if (sessionCount > MAX_SESSIONS) {
        // ✅ DB-side: find oldest excess session IDs and delete in one query
        const oldest = await prisma.session.findMany({
            where: { userId: signIn.user.id },
            orderBy: { createdAt: "asc" },
            take: sessionCount - MAX_SESSIONS + 1, // +1 accounts for new session
            select: { id: true }, // only fetch id, not full row
        });

        await prisma.session.deleteMany({
            where: { id: { in: oldest.map((s) => s.id) } },
        });
    }

    const tokenPayload = {
        userId: signIn.user.id,
        role: signIn.user.role,
        name: signIn.user.name,
        email: signIn.user.email,
        emailVerified: signIn.user.emailVerified,
    };

    let isOnboardingComplete: boolean | undefined = undefined;
    if (user.role === UserRole.ADMIN) {
        isOnboardingComplete = user.admin?.onboardingCompletedAt != null;
    }

    return {
        ...signIn,
        // ✅ Expose needPasswordChange so LoginForm can redirect to /set-password
        //    before granting access to any dashboard route.
        needPasswordChange: user.needPasswordChange,
        isOnboardingComplete,
        accessToken: tokenUtils.getAccessToken(tokenPayload),
        refreshToken: tokenUtils.getRefreshToken(tokenPayload),
    };
};

const me = async (user: IRequestUser) => {
    const isUserExist = await prisma.user.findUnique({
        where: {
            id: user.id,
        },
        include: {
            admin: true,
            staff: true,
        },
    });

    if (!isUserExist) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    return isUserExist;
};

const getNewToken = async (
    refreshToken: string,
    sessionToken?: string,
) => {
    if (!sessionToken) {
        throw new AppError(status.UNAUTHORIZED, "Session token is missing");
    }

    const verifiedRefreshToken = jwtUtils.verifyToken(
        refreshToken,
        REFRESH_TOKEN_SECRET,
    );

    if (!verifiedRefreshToken.success || !verifiedRefreshToken.data) {
        throw new AppError(status.UNAUTHORIZED, "Invalid refresh token");
    }

    const data = verifiedRefreshToken.data as JwtPayload;
    const refreshUserId = data.userId as string | undefined;
    if (!refreshUserId) {
        throw new AppError(status.UNAUTHORIZED, "Invalid refresh token");
    }

    // Bind the Better Auth session and refresh token to the same user. This is
    // both safer and more deterministic than first looking up an arbitrary
    // session and only verifying the refresh token afterwards.
    const session = await prisma.session.findFirst({
        where: {
            token: sessionToken,
            userId: refreshUserId,
        },
        select: {
            id: true,
            token: true,
        },
    });

    if (!session) {
        throw new AppError(status.UNAUTHORIZED, "Invalid session token");
    }

    const newAccessToken = tokenUtils.getAccessToken({
        userId: refreshUserId,
        role: data.role,
        name: data.name,
        email: data.email,
        status: data.status,
        isDeleted: data.isDeleted,
        emailVerified: data.emailVerified,
    });

    const newRefreshToken = tokenUtils.getRefreshToken({
        userId: refreshUserId,
        role: data.role,
        name: data.name,
        email: data.email,
        status: data.status,
        isDeleted: data.isDeleted,
        emailVerified: data.emailVerified,
    });

    const { token } = await prisma.session.update({
        where: {
            id: session.id,
        },
        data: {
            expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
            updatedAt: new Date(),
        },
        select: { token: true },
    });

    return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        sessionToken: token,
    };
};

const verifyEmail = async (email: string, otp: string) => {
    // Resolve identity and credential ownership first. ADMIN provisioning is
    // checked before the OTP is consumed so an incomplete tenant cannot become
    // stuck in a verified-but-unusable state.
    const [user, passwordAccount] = await Promise.all([
        prisma.user.findUnique({
            where: { email },
            select: { id: true, role: true },
        }),
        prisma.account.findFirst({
            where: {
                user: { email },
                providerId: "credential",
            },
            select: { userId: true },
        }),
    ]);

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found.");
    }

    if (!passwordAccount) {
        throw new AppError(
            status.BAD_REQUEST,
            "Email verification is not allowed for social login accounts.",
        );
    }

    let isOnboardingComplete: boolean | undefined = undefined;

    if (user.role === UserRole.ADMIN) {
        const admin = await prisma.adminProfile.findUnique({
            where: { userId: user.id },
            select: {
                onboardingCompletedAt: true,
                businessWebsite: { select: { id: true } },
                subscription: {
                    where: { status: SubscriptionStatus.ACTIVE },
                    select: { id: true },
                    take: 1,
                },
            },
        });

        if (!admin) {
            throw new AppError(status.CONFLICT, "Account provisioning is not complete yet.", {
                code: "ADMIN_PROFILE_NOT_FOUND",
                retryable: true,
            });
        }
        if (admin.subscription.length === 0) {
            throw new AppError(status.CONFLICT, "Subscription provisioning is not complete yet.", {
                code: "SUBSCRIPTION_PROVISIONING_INCOMPLETE",
                retryable: true,
            });
        }
        if (!admin.businessWebsite) {
            throw new AppError(status.CONFLICT, "Website provisioning is not complete yet.", {
                code: "WEBSITE_PROVISIONING_INCOMPLETE",
                retryable: true,
            });
        }

        isOnboardingComplete = admin.onboardingCompletedAt != null;
    }

    const result = await auth.api.verifyEmailOTP({
        body: { email, otp },
    });

    if (!result?.user) {
        throw new AppError(status.BAD_REQUEST, "Invalid OTP.");
    }

    if (result.user.emailVerified) {
        result.user = await prisma.user.update({
            where: { email },
            data: { status: AccountStatus.ACTIVE },
        });
    }

    const tokenPayload = {
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    };

    return {
        ...result,
        isOnboardingComplete,
        accessToken: tokenUtils.getAccessToken(tokenPayload),
        refreshToken: tokenUtils.getRefreshToken(tokenPayload),
    };
};

const resendOtp = async (email: string) => {
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, emailVerified: true },
    });

    // Preserve enumeration-resistant behaviour: callers receive the same 200
    // whether the account exists/already verified or a new email job was queued.
    if (!user || user.emailVerified) return;

    await AuthEmailOutbox.enqueueEmailVerification({
        userId: user.id,
        email: user.email,
    });
};

const forgotPassword = async (email: string) => {
    const user = await prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
        },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    const passwordAccount = await prisma.account.findFirst({
        where: {
            userId: user.id,
            providerId: "credential",
        },
        select: { id: true },
    });

    if (!passwordAccount) {
        throw new AppError(
            status.BAD_REQUEST,
            "Password reset is not available for social login accounts.",
        );
    }

    await auth.api.requestPasswordResetEmailOTP({
        body: { email },
    });
};

const resetPassword = async (
    email: string,
    otp: string,
    newPassword: string,
) => {
    const isUserExist = await prisma.user.findUnique({
        where: {
            email,
        },
    });

    if (!isUserExist) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    const passwordAccount = await prisma.account.findFirst({
        where: {
            userId: isUserExist.id,
            providerId: "credential",
        },
        select: { id: true },
    });

    if (!passwordAccount) {
        throw new AppError(
            status.BAD_REQUEST,
            "Password reset is not available for social login accounts.",
        );
    }

    await auth.api.resetPasswordEmailOTP({
        body: {
            email,
            otp,
            password: newPassword,
        },
    });

    await prisma.session.deleteMany({
        where: {
            userId: isUserExist.id,
        },
    });
};

const changePassword = async (
    payload: IChangePasswordPayload,
    sessionToken: string,
) => {
    const session = await auth.api.getSession({
        headers: new Headers({
            Authorization: `Bearer ${sessionToken}`,
        }),
    });

    if (!session) {
        throw new AppError(status.UNAUTHORIZED, "Invalid session token");
    }

    const isGoogleAccount = await prisma.account.count({
        where: {
            userId: session.user.id,
            providerId: "google",
        },
    });

    if (isGoogleAccount > 0) {
        throw new AppError(
            status.BAD_REQUEST,
            "Password cannot be changed for Google accounts.",
        );
    }

    const { currentPassword, newPassword } = payload;

    const result = await auth.api.changePassword({
        body: {
            currentPassword,
            newPassword,
            revokeOtherSessions: true,
        },
        headers: new Headers({
            Authorization: `Bearer ${sessionToken}`,
        }),
    });

    // ✅ Clear the forced-password-change flag now that the staff member has
    //    chosen their own password.  We do this after the password change
    //    succeeds so the flag is only cleared on a real credential update.
    await prisma.user.update({
        where: { id: session.user.id },
        data: { needPasswordChange: false },
    });

    const tokenPayload = {
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    };

    const accessToken = tokenUtils.getAccessToken(tokenPayload);
    const refreshToken = tokenUtils.getRefreshToken(tokenPayload);

    return {
        ...result,
        accessToken,
        refreshToken,
    };
};

const logout = async (sessionToken: string) => {
    const result = await auth.api.signOut({
        headers: new Headers({
            Authorization: `Bearer ${sessionToken}`,
        }),
    });

    return result;
};

const userService = {
    register,
    login,
    me,
    getNewToken,
    verifyEmail,
    resendOtp,
    forgotPassword,
    resetPassword,
    changePassword,
    logout,
};

export default userService;
