import cron from "node-cron";
import { BookingStatus } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import { queueBookingNotification } from "../lib/notifications/businessNotificationEvents";
import { fail, log } from "./index.cron";

const HOUR_MS = 60 * 60 * 1000;
const LOOKAHEAD_MS = 24 * HOUR_MS + 10 * 60 * 1000;
const REMINDER_24H_CATCHUP_MS = 2 * HOUR_MS;

const resolveBusinessTimezone = (businessHours: unknown) => {
  if (!businessHours || typeof businessHours !== "object" || Array.isArray(businessHours)) return "UTC";
  const value = (businessHours as Record<string, unknown>).timezone;
  if (typeof value !== "string" || !value.trim()) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
};

const localDateKey = (value: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/**
 * Scheduler-only producer. It never sends SMTP directly: it only inserts
 * idempotent delivery/outbox rows. The unique event key contains booking id,
 * template key and the scheduled occurrence, so polling/restarts cannot send
 * the same reminder twice.
 */
export const runBookingReminderJob = async (now = new Date()) => {
  const bookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.SCHEDULED,
      scheduledDate: {
        gt: now,
        lte: new Date(now.getTime() + LOOKAHEAD_MS),
      },
    },
    select: {
      id: true,
      scheduledDate: true,
      admin: { select: { businessHours: true } },
    },
    orderBy: { scheduledDate: "asc" },
    take: 2_000,
  });

  let reminder24hQueued = 0;
  let dayOfQueued = 0;
  for (const booking of bookings) {
    const occurrence = booking.scheduledDate.toISOString();
    const untilStart = booking.scheduledDate.getTime() - now.getTime();

    if (
      untilStart <= 24 * HOUR_MS + 10 * 60 * 1000
      && untilStart >= 24 * HOUR_MS - REMINDER_24H_CATCHUP_MS
    ) {
      const reminder = await queueBookingNotification(
        booking.id,
        "booking-reminder-24h",
        occurrence,
      );
      if (reminder.queued) reminder24hQueued += 1;
    }

    const timeZone = resolveBusinessTimezone(booking.admin.businessHours);
    if (localDateKey(now, timeZone) === localDateKey(booking.scheduledDate, timeZone)) {
      const dayOf = await queueBookingNotification(
        booking.id,
        "booking-reminder-day-of",
        occurrence,
      );
      if (dayOf.queued) dayOfQueued += 1;
    }
  }

  return { scanned: bookings.length, reminder24hQueued, dayOfQueued };
};

if (process.env.NODE_ENV !== "test") {
  cron.schedule("*/5 * * * *", async () => {
    try {
      const result = await runBookingReminderJob();
      if (result.reminder24hQueued || result.dayOfQueued) {
        log(`Booking reminders queued — 24h=${result.reminder24hQueued}, day-of=${result.dayOfQueued}`);
      }
    } catch (error) {
      fail("bookingReminder", error);
    }
  });
}
