import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { IRegisterUserPayload, ILoginUserPayload } from "./auth.interface";
import { auth } from "../../lib/auth";
import { tokenUtils } from "../../lib/utils/token";

const register = async ({ name, email, password }: IRegisterUserPayload) => {
    const existingUser = await prisma.user.findUnique({
        where: {
            email,
        },
    });

    if (existingUser) {
        throw new AppError(status.BAD_REQUEST, "User already exists");
    }

    const data = await auth.api.signUpEmail({
        body: {
            name,
            email,
            password,
        },
    });

    if (!data.user) {
        throw new AppError(status.BAD_REQUEST, "Failed to register user");
    }

    // const accessToken = tokenUtils.getAccessToken({
    //     userId: data.user.id,
    //     role: data.user.role,
    //     name: data.user.name,
    //     email: data.user.email,
    //     emailVerified: data.user.emailVerified,
    // });

    // const refreshToken = tokenUtils.getRefreshToken({
    //     userId: data.user.id,
    //     role: data.user.role,
    //     name: data.user.name,
    //     email: data.user.email,
    //     emailVerified: data.user.emailVerified,
    // });

    // return {
    //     ...data,
    //     accessToken,
    //     refreshToken,
    // };
    return data;
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

    const data = await auth.api.signInEmail({
        body: {
            email,
            password,
        },
    });

    const accessToken = tokenUtils.getAccessToken({
        userId: data.user.id,
        role: data.user.role,
        name: data.user.name,
        email: data.user.email,
        emailVerified: data.user.emailVerified,
    });

    const refreshToken = tokenUtils.getRefreshToken({
        userId: data.user.id,
        role: data.user.role,
        name: data.user.name,
        email: data.user.email,
        emailVerified: data.user.emailVerified,
    });

    return {
        ...data,
        accessToken,
        refreshToken,
    };
};

const userService = {
    register,
    // verifyEmail,
    login,
    // forgotPassword,
    // resetPassword,
    // resendVerificationEmail,
    // deleteUser,
    // logout,
};

export default userService;
