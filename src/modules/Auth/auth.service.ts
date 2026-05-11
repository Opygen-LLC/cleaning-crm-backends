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
    UserRole,
} from "../../generated/prisma/enums";
import { adminService } from "../Admin/admin.service";
import { subscriptionService } from "../Subscription/subscription.service";

//? Max sessions per user
const MAX_SESSIONS = 3;

const register = async ({
    businessName,
    name,
    email,
    password,
}: IRegisterUserPayload) => {
    const data = await auth.api
        .signUpEmail({
            body: { name, email, password },
        })
        .catch((err) => {
            if (err?.body?.code === "USER_ALREADY_EXISTS") {
                throw new AppError(status.BAD_REQUEST, "User already exists.");
            }
            throw err;
        });

    if (!data.user?.id) {
        throw new AppError(status.BAD_REQUEST, "Failed to register user.");
    }

    // ✅ Create admin first — subscription depends on admin.id
    const admin = await adminService
        .createAdmin({ userId: data.user.id, businessName })
        .catch(async () => {
            await prisma.user.delete({ where: { id: data.user.id } }).catch(() => {});
            throw new AppError(status.INTERNAL_SERVER_ERROR, "Registration failed. Please try again.");
        });

    // ✅ Create trial subscription using admin.id
    const subscription = await subscriptionService
        .createTrialSubscription(admin.id)
        .catch(async () => {
            // Roll back admin + user if subscription fails
            await prisma.user.delete({ where: { id: data.user.id } }).catch(() => {});
            throw new AppError(status.INTERNAL_SERVER_ERROR, "Registration failed. Please try again.");
        });

    return {
        user: data.user,
        admin,
        subscription,
    };
};

const login = async ({ email, password }: ILoginUserPayload) => {
    // ✅ Minimal select — no admin join, staff join only fetches status
    const user = await prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
            role: true,
            staff: { select: { status: true } }, // lightweight vs include
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

    // ✅ signInEmail is unavoidable (bcrypt) — but we can run session cleanup
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

    return {
        ...signIn,
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

const getNewToken = async (refreshToken: string, sessionToken: string) => {
    const isSessionTokenExists = await prisma.session.findFirst({
        where: {
            token: sessionToken,
        },
        include: {
            user: true,
        },
    });

    if (!isSessionTokenExists) {
        throw new AppError(status.UNAUTHORIZED, "Invalid session token");
    }

    const verifiedRefreshToken = jwtUtils.verifyToken(
        refreshToken,
        REFRESH_TOKEN_SECRET,
    );

    if (!verifiedRefreshToken.success && verifiedRefreshToken.error) {
        throw new AppError(status.UNAUTHORIZED, "Invalid refresh token");
    }

    const data = verifiedRefreshToken.data as JwtPayload;

    const newAccessToken = tokenUtils.getAccessToken({
        userId: data.userId,
        role: data.role,
        name: data.name,
        email: data.email,
        status: data.status,
        isDeleted: data.isDeleted,
        emailVerified: data.emailVerified,
    });

    const newRefreshToken = tokenUtils.getRefreshToken({
        userId: data.userId,
        role: data.role,
        name: data.name,
        email: data.email,
        status: data.status,
        isDeleted: data.isDeleted,
        emailVerified: data.emailVerified,
    });

    const { token } = await prisma.session.update({
        where: {
            id: isSessionTokenExists.id,
        },
        data: {
            token: sessionToken,
            expiresAt: new Date(Date.now() + 60 * 60 * 60 * 24 * 1000),
            updatedAt: new Date(),
        },
    });

    return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        sessionToken: token,
    };
};

const verifyEmail = async (email: string, otp: string) => {
    // Single query: find user AND verify credential account exists simultaneously
    const [user, passwordAccount] = await Promise.all([
        prisma.user.findUnique({
            where: { email },
            select: { id: true },
        }),
        prisma.account.findFirst({
            where: {
                user: { email }, // join via relation instead of 2 queries
                providerId: "credential",
            },
            select: { userId: true }, // only fetch what's needed
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

    const result = await auth.api.verifyEmailOTP({
        body: { email, otp },
    });

    if (!result?.user) {
        throw new AppError(status.BAD_REQUEST, "Invalid OTP.");
    }

    // Only hit the DB if status update is actually needed
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
        accessToken: tokenUtils.getAccessToken(tokenPayload),
        refreshToken: tokenUtils.getRefreshToken(tokenPayload),
    };
};

const resendOtp = async (email: string) => {
    await auth.api.sendVerificationOTP({
        body: { email, type: "email-verification" },
        //? type: "sign-in" | "email-verification" | "forget-password" | "change-email";
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
