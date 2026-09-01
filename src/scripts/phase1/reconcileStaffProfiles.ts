import { prisma } from "../../lib/prisma/prisma";
import { UserRole } from "../../generated/prisma/enums";

/**
 * Read-only STAFF provisioning reconciliation.
 *
 * StaffProfile.userId is UNIQUE, so the database already enforces "at most
 * one" profile. This report verifies the other half of the invariant:
 * every STAFF user has exactly one profile and every profile belongs to a
 * STAFF user. It intentionally does not invent missing employment/contact
 * data; broken rows are reported for deterministic admin repair.
 */
async function main() {
  const [staffUsers, profilesWithWrongRole] = await Promise.all([
    prisma.user.findMany({
      where: { role: UserRole.STAFF },
      select: {
        id: true,
        email: true,
        status: true,
        staff: { select: { id: true, adminId: true, status: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.staffProfile.findMany({
      where: { user: { role: { not: UserRole.STAFF } } },
      select: {
        id: true,
        adminId: true,
        userId: true,
        user: { select: { email: true, role: true, status: true } },
      },
    }),
  ]);

  const missingProfiles = staffUsers
    .filter((user) => !user.staff)
    .map((user) => ({ userId: user.id, email: user.email, accountStatus: user.status }));

  const report = {
    generatedAt: new Date().toISOString(),
    invariant: "Every User(role=STAFF) has exactly one StaffProfile",
    counts: {
      staffUsers: staffUsers.length,
      missingProfiles: missingProfiles.length,
      profilesOwnedByNonStaffUsers: profilesWithWrongRole.length,
    },
    missingProfiles,
    profilesOwnedByNonStaffUsers: profilesWithWrongRole,
    databaseGuarantees: {
      atMostOneProfilePerUser: "StaffProfile.userId is UNIQUE",
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (process.argv.includes("--ci") && (missingProfiles.length > 0 || profilesWithWrongRole.length > 0)) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("Staff profile reconciliation failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
