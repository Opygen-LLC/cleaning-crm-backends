import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import {
    RecurringFrequency,
    RecurringStatus,
    WeekDay,
    BookingStatus,
} from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import {
    IRecurringScheduleCreate,
    IRecurringScheduleUpdate,
    IRecurringScheduleFilters,
} from "./recurringBooking.interface";
import { QueryBuilder } from "../../lib/utils/QueryBuilder";
import { IQueryParams } from "../../interface/query.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DAY_MAP: Record<WeekDay, number> = {
    [WeekDay.SUNDAY]:    0,
    [WeekDay.MONDAY]:    1,
    [WeekDay.TUESDAY]:   2,
    [WeekDay.WEDNESDAY]: 3,
    [WeekDay.THURSDAY]:  4,
    [WeekDay.FRIDAY]:    5,
    [WeekDay.SATURDAY]:  6,
};

/**
 * Generates a unique recurring schedule reference: #RS-0001
 */
const generateScheduleRef = async (): Promise<string> => {
    const last = await prisma.recurringSchedule.findFirst({
        orderBy: { createdAt: "desc" },
        select: { scheduleRef: true },
    });
    let next = 1;
    if (last?.scheduleRef) {
        const parts = last.scheduleRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) next = num + 1;
    }
    return `#RS-${next.toString().padStart(4, "0")}`;
};

/**
 * Resolves the admin profile ID from the authenticated user.
 */

/**
 * Computes the first UTC DateTime on or after `from` that falls on `dayOfWeek`
 * at `timeHour:timeMinute` UTC.
 *
 * Used both at schedule-creation time (to set nextRunAt) and after each
 * booking is generated (to advance nextRunAt by the frequency interval).
 */
export const computeNextRunAt = (
    from:      Date,
    dayOfWeek: WeekDay,
    timeHour:  number,
    timeMinute: number,
    frequency: RecurringFrequency,
): Date => {
    const targetDow = DAY_MAP[dayOfWeek];
    const candidate = new Date(from);

    // Move to the correct day-of-week (UTC)
    const currentDow = candidate.getUTCDay();
    let daysUntil = (targetDow - currentDow + 7) % 7;

    // If today IS the target day but the time has already passed, push to next
    // occurrence of that day (7 days / 14 days / ~30 days depending on frequency)
    if (daysUntil === 0) {
        const todayAtTime = new Date(candidate);
        todayAtTime.setUTCHours(timeHour, timeMinute, 0, 0);
        if (candidate >= todayAtTime) {
            daysUntil = frequencyToDays(frequency);
        }
    }

    candidate.setUTCDate(candidate.getUTCDate() + daysUntil);
    candidate.setUTCHours(timeHour, timeMinute, 0, 0);
    return candidate;
};

/**
 * Computes the NEXT nextRunAt after a booking has been generated.
 * Advances by the schedule's frequency from the current nextRunAt.
 */
export const advanceNextRunAt = (
    current:   Date,
    dayOfWeek: WeekDay,
    timeHour:  number,
    timeMinute: number,
    frequency: RecurringFrequency,
): Date => {
    const next = new Date(current);
    const days = frequencyToDays(frequency);
    next.setUTCDate(next.getUTCDate() + days);
    // Keep the same time and day-of-week — it should already land correctly
    // for WEEKLY/BIWEEKLY.  For MONTHLY we do a calendar-month advance instead.
    if (frequency === RecurringFrequency.MONTHLY) {
        const targetYear = current.getUTCFullYear();
        const targetMonth = current.getUTCMonth() + 1;
        const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
        next.setTime(Date.UTC(
            targetYear,
            targetMonth,
            Math.min(current.getUTCDate(), lastDay),
            timeHour,
            timeMinute,
            0,
            0,
        ));
    }
    next.setUTCHours(timeHour, timeMinute, 0, 0);
    return next;
};

const frequencyToDays = (f: RecurringFrequency): number => {
    if (f === RecurringFrequency.WEEKLY)    return 7;
    if (f === RecurringFrequency.BIWEEKLY)  return 14;
    return 30; // MONTHLY — approximate; advanceNextRunAt uses calendar month
};

// ─── Standard includes ────────────────────────────────────────────────────────

const scheduleInclude = {
    client: {
        select: { id: true, name: true, email: true, phone: true },
    },
    staffAssignments: {
        include: {
            staff: {
                include: {
                    user: { select: { id: true, name: true, email: true } },
                },
            },
        },
    },
} as const;

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createSchedule = async (
    payload: IRecurringScheduleCreate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    // Verify client belongs to this admin
    const client = await prisma.client.findFirst({
        where: { id: payload.clientId, adminId },
    });
    if (!client) throw new AppError(status.NOT_FOUND, "Client not found");

    // Verify staff belong to this admin (if provided)
    if (payload.staffIds?.length) {
        const staffCount = await prisma.staffProfile.count({
            where: { id: { in: payload.staffIds }, adminId },
        });
        if (staffCount !== payload.staffIds.length) {
            throw new AppError(status.BAD_REQUEST, "One or more staff members not found");
        }
    }

    const scheduleRef = await generateScheduleRef();

    // Compute the first nextRunAt from the provided startDate
    const startDate = new Date(payload.startDate);
    const nextRunAt = computeNextRunAt(
        startDate,
        payload.dayOfWeek,
        payload.timeHour,
        payload.timeMinute,
        payload.frequency,
    );

    return prisma.recurringSchedule.create({
        data: {
            scheduleRef,
            adminId,
            clientId:     payload.clientId,
            serviceType:  payload.serviceType,
            address:      payload.address,
            durationMins: payload.durationMins,
            total:        payload.total,
            notes:        payload.notes,
            frequency:    payload.frequency,
            dayOfWeek:    payload.dayOfWeek,
            timeHour:     payload.timeHour,
            timeMinute:   payload.timeMinute,
            startDate,
            nextRunAt,
            ...(payload.staffIds?.length && {
                staffAssignments: {
                    createMany: {
                        data: payload.staffIds.map((staffId) => ({ staffId })),
                    },
                },
            }),
        },
        include: scheduleInclude,
    });
};

const getAllSchedules = async (queryParams: IQueryParams, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    return new QueryBuilder(prisma.recurringSchedule, queryParams, {
        searchableFields: ["scheduleRef", "address"],
        filterableFields: ["status", "frequency"],
    })
        .where({ adminId })
        .search()
        .filter()
        .sort()
        .paginate()
        .include(scheduleInclude)
        .execute();
};

const getScheduleById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const schedule = await prisma.recurringSchedule.findFirst({
        where: { id, adminId },
        include: scheduleInclude,
    });

    if (!schedule) throw new AppError(status.NOT_FOUND, "Recurring schedule not found");
    return schedule;
};

const updateSchedule = async (
    id: string,
    payload: IRecurringScheduleUpdate,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    const existing = await prisma.recurringSchedule.findFirst({
        where: { id, adminId },
    });
    if (!existing) throw new AppError(status.NOT_FOUND, "Recurring schedule not found");

    if (existing.status === RecurringStatus.CANCELLED) {
        throw new AppError(status.BAD_REQUEST, "Cannot update a cancelled schedule");
    }

    // If frequency/day/time changed, recompute nextRunAt from now
    const frequencyChanged = payload.frequency && payload.frequency !== existing.frequency;
    const dayChanged       = payload.dayOfWeek  && payload.dayOfWeek  !== existing.dayOfWeek;
    const timeChanged      = (payload.timeHour   !== undefined && payload.timeHour   !== existing.timeHour)
                          || (payload.timeMinute  !== undefined && payload.timeMinute  !== existing.timeMinute);

    let nextRunAt: Date | undefined;
    if (frequencyChanged || dayChanged || timeChanged) {
        nextRunAt = computeNextRunAt(
            new Date(),
            payload.dayOfWeek  ?? existing.dayOfWeek,
            payload.timeHour   ?? existing.timeHour,
            payload.timeMinute ?? existing.timeMinute,
            payload.frequency  ?? existing.frequency,
        );
    }

    return prisma.$transaction(async (tx) => {
        // Replace staff assignments if provided
        if (payload.staffIds !== undefined) {
            await tx.recurringStaffAssignment.deleteMany({ where: { scheduleId: id } });
            if (payload.staffIds.length) {
                await tx.recurringStaffAssignment.createMany({
                    data: payload.staffIds.map((staffId) => ({ scheduleId: id, staffId })),
                });
            }
        }

        const { staffIds: _staffIds, ...rest } = payload;

        return tx.recurringSchedule.update({
            where: { id },
            data: {
                ...rest,
                ...(nextRunAt && { nextRunAt }),
            },
            include: scheduleInclude,
        });
    });
};

const pauseSchedule = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.recurringSchedule.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Recurring schedule not found");
    if (existing.status !== RecurringStatus.ACTIVE) {
        throw new AppError(status.BAD_REQUEST, "Only active schedules can be paused");
    }
    return prisma.recurringSchedule.update({
        where: { id },
        data: { status: RecurringStatus.PAUSED },
        include: scheduleInclude,
    });
};

const resumeSchedule = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.recurringSchedule.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Recurring schedule not found");
    if (existing.status !== RecurringStatus.PAUSED) {
        throw new AppError(status.BAD_REQUEST, "Only paused schedules can be resumed");
    }
    // Recompute nextRunAt from now when resuming
    const nextRunAt = computeNextRunAt(
        new Date(),
        existing.dayOfWeek,
        existing.timeHour,
        existing.timeMinute,
        existing.frequency,
    );
    return prisma.recurringSchedule.update({
        where: { id },
        data: { status: RecurringStatus.ACTIVE, nextRunAt },
        include: scheduleInclude,
    });
};

const cancelSchedule = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.recurringSchedule.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Recurring schedule not found");
    if (existing.status === RecurringStatus.CANCELLED) {
        throw new AppError(status.BAD_REQUEST, "Schedule is already cancelled");
    }
    return prisma.recurringSchedule.update({
        where: { id },
        data: { status: RecurringStatus.CANCELLED },
        include: scheduleInclude,
    });
};

const deleteSchedule = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const existing = await prisma.recurringSchedule.findFirst({ where: { id, adminId } });
    if (!existing) throw new AppError(status.NOT_FOUND, "Recurring schedule not found");
    return prisma.recurringSchedule.delete({ where: { id } });
};

// ─── Stats ────────────────────────────────────────────────────────────────────

const getScheduleStats = async (user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const [total, active, paused, cancelled] = await Promise.all([
        prisma.recurringSchedule.count({ where: { adminId } }),
        prisma.recurringSchedule.count({ where: { adminId, status: RecurringStatus.ACTIVE } }),
        prisma.recurringSchedule.count({ where: { adminId, status: RecurringStatus.PAUSED } }),
        prisma.recurringSchedule.count({ where: { adminId, status: RecurringStatus.CANCELLED } }),
    ]);

    return { total, active, paused, cancelled };
};

// ─── Manual generate ──────────────────────────────────────────────────────────

/**
 * Manually triggers booking generation for a single ACTIVE schedule,
 * regardless of nextRunAt.  Used by the admin "Generate booking" button.
 * After creating the booking it advances nextRunAt exactly as the cron does.
 */
const generateNextBooking = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const schedule = await prisma.recurringSchedule.findFirst({
        where: { id, adminId },
        include: { staffAssignments: { select: { staffId: true } } },
    });

    if (!schedule) throw new AppError(status.NOT_FOUND, "Recurring schedule not found");

    if (schedule.status !== RecurringStatus.ACTIVE) {
        throw new AppError(
            status.BAD_REQUEST,
            `Only ACTIVE schedules can generate bookings. Current status: ${schedule.status}`,
        );
    }

    const now = new Date();

    // Generate booking ref — mirrors the cron helper
    const lastBooking = await prisma.booking.findFirst({
        orderBy: { createdAt: "desc" },
        select: { bookingRef: true },
    });
    let nextNum = 1;
    if (lastBooking?.bookingRef) {
        const parts = lastBooking.bookingRef.split("-");
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num)) nextNum = num + 1;
    }
    const bookingRef = `#OP-BK-${nextNum.toString().padStart(4, "0")}`;

    const result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.create({
            data: {
                bookingRef,
                adminId:      schedule.adminId,
                clientId:     schedule.clientId,
                serviceType:  schedule.serviceType,
                address:      schedule.address,
                scheduledDate: schedule.nextRunAt,
                durationMins: schedule.durationMins,
                total:        schedule.total,
                notes:        schedule.notes
                    ? `[Manual from ${schedule.scheduleRef}] ${schedule.notes}`
                    : `Manually generated from recurring schedule ${schedule.scheduleRef}`,
                status: BookingStatus.SCHEDULED,
                recurringScheduleId: schedule.id,
                ...(schedule.staffAssignments.length && {
                    staffAssignments: {
                        createMany: {
                            data: schedule.staffAssignments.map(({ staffId }) => ({ staffId })),
                        },
                    },
                }),
            },
        });

        await tx.client.update({
            where: { id: schedule.clientId },
            data: {
                totalBookings:   { increment: 1 },
                lastBookingDate: schedule.nextRunAt,
            },
        });

        const nextRunAt = advanceNextRunAt(
            schedule.nextRunAt,
            schedule.dayOfWeek,
            schedule.timeHour,
            schedule.timeMinute,
            schedule.frequency,
        );

        const updatedSchedule = await tx.recurringSchedule.update({
            where: { id: schedule.id },
            data: { lastRunAt: now, nextRunAt },
            include: scheduleInclude,
        });

        return { booking, schedule: updatedSchedule };
    });

    return result;
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const recurringBookingService = {
    createSchedule,
    getAllSchedules,
    getScheduleById,
    updateSchedule,
    pauseSchedule,
    resumeSchedule,
    cancelSchedule,
    deleteSchedule,
    getScheduleStats,
    generateNextBooking,
};
