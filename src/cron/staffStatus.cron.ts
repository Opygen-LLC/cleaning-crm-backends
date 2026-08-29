import cron from "node-cron";
import { StaffStatus, WeekDay } from "../generated/prisma/enums";
import { fail, log } from "./index.cron";
import { prisma } from "../lib/prisma/prisma";

const DAY_MAP: WeekDay[] = [
    WeekDay.SUNDAY,
    WeekDay.MONDAY,
    WeekDay.TUESDAY,
    WeekDay.WEDNESDAY,
    WeekDay.THURSDAY,
    WeekDay.FRIDAY,
    WeekDay.SATURDAY,
];

//* Every 6 hours – sync staff status based on availability and approved leaves
cron.schedule("0 */6 * * *", async () => {
    try {
        log("Running staff status sync...");

        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        const todayWeekDay = DAY_MAP[today.getUTCDay()];

        // Keep manual access disable separate from the operational availability status.
        const staffList = await prisma.staffProfile.findMany({
            where: { manuallyInactive: false },
            select: {
                id: true,
                status: true,
                staffAvailability: {
                    where: { day: todayWeekDay },
                    select: { isActive: true },
                },
                staffLeave: {
                    where: {
                        status: "APPROVED",
                        startDate: { lte: today },
                        endDate: { gte: today },
                    },
                    select: { id: true },
                },
            },
        });

        if (staffList.length === 0) {
            log("No eligible staff found");
            return;
        }

        // Resolve the correct status for each staff member
        const onLeaveIds: string[] = [];
        const inactiveIds: string[] = [];
        const activeIds: string[] = [];

        for (const staff of staffList) {
            const hasApprovedLeave = staff.staffLeave.length > 0;
            const todaySlot = staff.staffAvailability[0];
            const isUnavailableToday = todaySlot && !todaySlot.isActive;

            if (hasApprovedLeave) {
                if (staff.status !== StaffStatus.ON_LEAVE)
                    onLeaveIds.push(staff.id);
            } else if (isUnavailableToday) {
                if (staff.status !== StaffStatus.INACTIVE)
                    inactiveIds.push(staff.id);
            } else {
                if (staff.status !== StaffStatus.ACTIVE)
                    activeIds.push(staff.id);
            }
        }

        const hasNoChanges =
            onLeaveIds.length === 0 &&
            inactiveIds.length === 0 &&
            activeIds.length === 0;

        if (hasNoChanges) {
            log("No staff status changes required");
            return;
        }

        const [onLeave, inactive, active] = await prisma.$transaction([
            // Mark staff with approved leave → ON_LEAVE
            prisma.staffProfile.updateMany({
                where: { id: { in: onLeaveIds } },
                data: { status: StaffStatus.ON_LEAVE },
            }),
            // Mark staff unavailable today → INACTIVE
            prisma.staffProfile.updateMany({
                where: { id: { in: inactiveIds } },
                data: { status: StaffStatus.INACTIVE },
            }),
            // Restore everyone else → ACTIVE
            prisma.staffProfile.updateMany({
                where: { id: { in: activeIds } },
                data: { status: StaffStatus.ACTIVE },
            }),
        ]);

        log(
            `Staff status sync complete | ` +
                `ON_LEAVE: ${onLeave.count} | ` +
                `INACTIVE: ${inactive.count} | ` +
                `ACTIVE (restored): ${active.count}`,
        );
    } catch (err) {
        fail("staffStatusSync", err);
    }
});
