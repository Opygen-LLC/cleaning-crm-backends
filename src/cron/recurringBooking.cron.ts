import cron from "node-cron";
import { RecurringStatus, BookingStatus } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import { advanceNextRunAt } from "../modules/RecurringBooking/recurringBooking.service";
import { fail, log } from "./index.cron";

// ─── Booking ref generator (mirrors booking.service.ts) ───────────────────────

export const generateBookingRef = async (tx: any): Promise<string> => {
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

export interface RecurringBookingEngineResult {
    dueCount: number;
    created: number;
    failed: number;
    failures: { scheduleRef: string; error: unknown }[];
}

/**
 * Core engine, extracted out of the cron.schedule callback so it can be
 * unit-tested with a mocked Prisma client and an injected "now" — without
 * depending on node-cron or a real database.
 *
 * Any Prisma client (or a mock exposing the same shape) can be passed in;
 * this lets tests use vi.fn()-based stubs.
 */
export const runRecurringBookingEngine = async (
    prismaClient: any = prisma,
    now: Date = new Date(),
): Promise<RecurringBookingEngineResult> => {
    log("Running recurring booking engine...");

    // Find all active schedules that are due
    const dueSchedules = await prismaClient.recurringSchedule.findMany({
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
        return { dueCount: 0, created: 0, failed: 0, failures: [] };
    }

    log(`Found ${dueSchedules.length} due schedule(s), generating bookings...`);

    let created = 0;
    let failed  = 0;
    const failures: { scheduleRef: string; error: unknown }[] = [];

    for (const schedule of dueSchedules) {
        try {
            await prismaClient.$transaction(async (tx: any) => {
                const bookingRef = await generateBookingRef(tx);

                // Build the scheduledDate from the schedule's nextRunAt
                const scheduledDate = new Date(schedule.nextRunAt);

                // Create the booking
                await tx.booking.create({
                    data: {
                        bookingRef,
                        adminId:      schedule.adminId,
                        clientId:     schedule.clientId,
                        serviceCatalogId: schedule.serviceCatalogId,
                        serviceType: schedule.serviceType,
                        serviceNameSnapshot: schedule.serviceNameSnapshot,
                        priceSnapshot: schedule.priceSnapshot,
                        durationSnapshot: schedule.durationSnapshot,
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
                                    data: schedule.staffAssignments.map(
                                        ({ staffId }: { staffId: string }) => ({ staffId }),
                                    ),
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
            failures.push({ scheduleRef: schedule.scheduleRef, error: err });
            fail(`recurringBooking[${schedule.scheduleRef}]`, err);
        }
    }

    log(
        `Recurring booking engine done | created: ${created} | failed: ${failed}`,
    );

    return { dueCount: dueSchedules.length, created, failed, failures };
};

// ─── Cron: runs every hour on the hour ────────────────────────────────────────
// We check for all ACTIVE schedules whose nextRunAt <= now and generate a
// Booking for each.  After creating the booking we advance nextRunAt by the
// schedule's frequency so it fires again at the correct time.
//
// This wrapper is intentionally thin — all logic lives in
// runRecurringBookingEngine so it can be exercised directly by tests
// (see src/cron/__tests__/recurringBooking.cron.test.ts).

if (process.env.NODE_ENV !== "test") {
    cron.schedule("0 * * * *", async () => {
        try {
            await runRecurringBookingEngine(prisma, new Date());
        } catch (err) {
            fail("recurringBookingEngine", err);
        }
    });
}
