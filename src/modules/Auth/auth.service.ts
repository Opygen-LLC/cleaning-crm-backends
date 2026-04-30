import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { IRegisterUserPayload, ILoginUserPayload } from "./auth.interface";
import { auth } from "../../lib/auth";
import { tokenUtils } from "../../lib/utils/token";
import { IRequestUser } from "../../types/requestUser.interface";
import { JwtPayload } from "jsonwebtoken";
import { jwtUtils } from "../../lib/utils/jwt";
import { REFRESH_TOKEN_SECRET } from "../../config/ENV";
import { AccountStatus } from "../../generated/prisma/enums";
import { adminService } from "../Admin/admin.service";

const register = async ({
    businessName,
    name,
    email,
    password,
}: IRegisterUserPayload) => {
    const data = await auth.api.signUpEmail({
        body: { name, email, password },
    });

    if (!data.user?.id) {
        throw new AppError(status.BAD_REQUEST, "Failed to register user");
    }

    const admin = await adminService.createAdmin({
        userId: data.user.id,
        businessName,
    });

    return {
        user: data.user,
        admin,
    };
};

const login = async ({ email, password }: ILoginUserPayload) => {
    const user = await prisma.user.findUnique({
        where: {
            email,
        },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    // ✅ Sign-in
    const signIn = await auth.api.signInEmail({
        body: { email, password },
    });

    if (!signIn.user.emailVerified) {
        return {
            data: signIn,
            accessToken: null,
            refreshToken: null,
        };
    }

    // ✅ Enforce max 3 sessions: evict only the oldest if limit exceeded
    const sessions = await prisma.session.findMany({
        where: { userId: signIn.user.id },
        orderBy: { createdAt: "asc" },
    });

    if (sessions.length > 3) {
        // Delete oldest sessions, keep the 3 most recent (including the new one)
        const sessionsToDelete = sessions.slice(0, sessions.length - 1);
        await prisma.session.deleteMany({
            where: {
                id: { in: sessionsToDelete.map((s) => s.id) },
            },
        });
    }

    const tokenPayload = {
        userId: signIn.user.id,
        role: signIn.user.role,
        name: signIn.user.name,
        email: signIn.user.email,
        emailVerified: signIn.user.emailVerified,
    };

    const accessToken = tokenUtils.getAccessToken(tokenPayload);
    const refreshToken = tokenUtils.getRefreshToken(tokenPayload);

    return {
        ...signIn,
        accessToken,
        refreshToken,
    };
};

const me = async (user: IRequestUser) => {
    const isUserExist = await prisma.user.findUnique({
        where: {
            id: user.id,
        },
        include: {
            sessions: true,
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
    const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found.");
    }

    // Check if user has a credentials/password account
    const passwordAccount = await prisma.account.findFirst({
        where: {
            userId: user.id,
            providerId: "credential", // adjust if your auth uses another name
        },
    });

    if (!passwordAccount) {
        throw new AppError(
            status.BAD_REQUEST,
            "Email verification is not allowed for social login accounts.",
        );
    }

    const result = await auth.api.verifyEmailOTP({
        body: {
            email,
            otp,
        },
    });

    if (!result?.user) {
        throw new AppError(status.BAD_REQUEST, "Invalid OTP.");
    }

    if (result.status && !result.user.emailVerified) {
        await prisma.user.update({
            where: {
                email,
            },
            data: {
                emailVerified: true,
                status: AccountStatus.ACTIVE,
            },
        });
    }

    const accessToken = tokenUtils.getAccessToken({
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    });

    const refreshToken = tokenUtils.getRefreshToken({
        userId: result.user.id,
        role: result.user.role,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
    });

    return {
        ...result,
        accessToken,
        refreshToken,
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
    logout,
};

export default userService;
