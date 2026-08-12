import { SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD } from "../../config/ENV";
import { AccountStatus, UserRole } from "../../generated/prisma/enums";
import { auth } from "../auth";
import { prisma } from "../prisma/prisma";
import logger from "../logger";

export const seedSuperAdmin = async () => {
    try {
        const isSuperAdminExist = await prisma.user.findFirst({
            where: {
                role: UserRole.SUPER_ADMIN,
            },
        });

        if (isSuperAdminExist) {
            logger.info(
                "Super Admin already exists. Skipping seeding super admin.",
            );
            return;
        }

        const superAdminUser = await auth.api.signUpEmail({
            body: {
                email: SUPER_ADMIN_EMAIL,
                password: SUPER_ADMIN_PASSWORD,
                name: "Super Admin",
                role: UserRole.SUPER_ADMIN,
                status: AccountStatus.ACTIVE,
                rememberMe: false,
            },
        });

        await prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: {
                    id: superAdminUser.user.id,
                },
                data: {
                    emailVerified: true,
                },
            });
        });

        const superAdmin = await prisma.user.findUnique({
            where: {
                email: SUPER_ADMIN_EMAIL,
            },
        });

        logger.info(`Super Admin created: ${superAdmin?.id ?? "unknown"}`);
    } catch (error) {
        await prisma.user.delete({
            where: {
                email: SUPER_ADMIN_EMAIL,
            },
        });
    }
};
