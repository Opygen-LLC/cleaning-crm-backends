import { prisma } from "../lib/prisma/prisma";
import { WebsiteProvisioningService } from "../modules/Website/websiteProvisioning.service";

const BATCH_SIZE = 100;

const run = async () => {
  let provisioned = 0;

  for (;;) {
    const admins = await prisma.adminProfile.findMany({
      where: { businessWebsite: { is: null } },
      select: {
        id: true,
        userId: true,
        businessName: true,
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });

    if (admins.length === 0) break;

    for (const admin of admins) {
      const result = await prisma.$transaction((tx: any) =>
        WebsiteProvisioningService.provisionDefaultWebsiteForAdminTx(tx, {
          adminId: admin.id,
          businessName: admin.businessName,
          createdByUserId: admin.userId,
        }),
      );

      if (result.created) provisioned += 1;
      process.stdout.write(
        `Provisioned website for admin ${admin.id} at subdomain ${result.website.subdomain}\n`,
      );
    }
  }

  process.stdout.write(`Website backfill complete. Created ${provisioned} website(s).\n`);
};

run()
  .catch((error) => {
    console.error("Website backfill failed. Rerun after fixing the reported error; completed tenants are safe.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
