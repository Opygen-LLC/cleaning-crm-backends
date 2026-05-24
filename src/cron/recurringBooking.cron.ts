import cron from "node-cron";
import { RecurringStatus, BookingStatus } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import { advanceNextRunAt } from "../modules/RecurringBooking/recurringBooking.service";
import { fail, log } from "./index.cron";

// ─── Booking ref generator (mirrors booking.service.ts) ───────────────────────

const generateBookingRef = async (tx: typeof prisma): Promise<string> => {
    const last = await tx.booking.findFirst({
        orderBy: { createdAt: "desc" },
        select: { bookingRef: true },
    });
    let next = 1;
    if (last?.bookingRef) {
        const parts = last.bookingRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) next = num + 1;
    }
    return `#OP-BK-${next.toString().padStart(4, "0")}`;
};

// ─── Cron: runs every hour on the hour ────────────────────────────────────────
// We check for all ACTIVE schedules whose nextRunAt <= now and generate a
// Booking for each.  After creating the booking we advance nextRunAt by the
// schedule's frequency so it fires again at the correct time.

cron.schedule("0 * * * *", async () => {
    try {
        log("Running recurring booking engine...");

        const now = new Date();

        // Find all active schedules that are due
        const dueSchedules = await prisma.recurringSchedule.findMany({
            where: {
                status:    RecurringStatus.ACTIVE,
                nextRunAt: { lte: now },
            },
            include: {
                staffAssignments: { select: { staffId: true } },
            },
        });

        if (dueSchedules.length === 0) {
            log("No recurring schedules due — skipping");
            return;
        }

        log(`Found ${dueSchedules.length} due schedule(s), generating bookings...`);

        let created = 0;
        let failed  = 0;

        for (const schedule of dueSchedules) {
            try {
                await prisma.$transaction(async (tx) => {
                    const bookingRef = await generateBookingRef(tx as any);

                    // Build the scheduledDate from the schedule's nextRunAt
                    const scheduledDate = new Date(schedule.nextRunAt);

                    // Create the booking
                    const booking = await tx.booking.create({
                        data: {
                            bookingRef,
                            adminId:      schedule.adminId,
                            clientId:     schedule.clientId,
                            serviceType:  schedule.serviceType,
                            address:      schedule.address,
                            scheduledDate,
                            durationMins: schedule.durationMins,
                            total:        schedule.total,
                            notes:        schedule.notes
                                ? `[Auto-generated from ${schedule.scheduleRef}] ${schedule.notes}`
                                : `Auto-generated from recurring schedule ${schedule.scheduleRef}`,
                            status: BookingStatus.SCHEDULED,
                            // Link staff from the schedule
                            ...(schedule.staffAssignments.length && {
                                staffAssignments: {
                                    createMany: {
                                        data: schedule.staffAssignments.map(({ staffId }) => ({
                                            staffId,
                                        })),
                                    },
                                },
                            }),
                        },
                    });

                    // Update client aggregate
                    await tx.client.update({
                        where: { id: schedule.clientId },
                        data: {
                            totalBookings:   { increment: 1 },
                            lastBookingDate: scheduledDate,
                        },
                    });

                    // Advance nextRunAt by one frequency period
                    const nextRunAt = advanceNextRunAt(
                        schedule.nextRunAt,
                        schedule.dayOfWeek,
                        schedule.timeHour,
                        schedule.timeMinute,
                        schedule.frequency,
                    );

                    await tx.recurringSchedule.update({
                        where: { id: schedule.id },
                        data: {
                            lastRunAt: now,
                            nextRunAt,
                        },
                    });

                    log(
                        `  ✓ Created ${bookingRef} from ${schedule.scheduleRef} ` +
                        `(next run: ${nextRunAt.toISOString()})`,
                    );
                });

                created++;
            } catch (err) {
                failed++;
                fail(`recurringBooking[${schedule.scheduleRef}]`, err);
            }
        }

        log(
            `Recurring booking engine done | created: ${created} | failed: ${failed}`,
        );
    } catch (err) {
        fail("recurringBookingEngine", err);
    }
});
