import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import redis from "../../config/redis";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { Prisma } from "../../generated/prisma/client";
import type { IRequestUser } from "../../types/requestUser.interface";
import type {
  LeadActivityStatusInput,
  LeadActivityTypeInput,
} from "./leadActivity.validation";

export interface LeadActivityCreatePayload {
  type: LeadActivityTypeInput;
  status?: LeadActivityStatusInput;
  scheduledAt?: string;
  assignedToUserId?: string | null;
  note?: string;
  outcome?: string;
}

export interface LeadActivityUpdatePayload {
  type?: LeadActivityTypeInput;
  status?: LeadActivityStatusInput;
  scheduledAt?: string | null;
  assignedToUserId?: string | null;
  note?: string | null;
  outcome?: string | null;
}

const CONTACT_TYPES: readonly LeadActivityTypeInput[] = [
  "CALL",
  "EMAIL",
  "FOLLOW_UP",
  "MEETING",
];

const activityInclude = {
  assignedTo: { select: { id: true, name: true, email: true } },
  creator: { select: { id: true, name: true, email: true } },
} as const;

const ensureLead = async (
  db: Pick<Prisma.TransactionClient, "lead">,
  adminId: string,
  leadId: string,
) => {
  const lead = await db.lead.findFirst({
    where: { id: leadId, adminId },
    select: { id: true },
  });
  if (!lead) throw new AppError(status.NOT_FOUND, "Lead not found");
};

export const ensureLeadActivityAssignee = async (
  db: Pick<Prisma.TransactionClient, "user">,
  adminId: string,
  assignedToUserId?: string | null,
) => {
  if (!assignedToUserId) return;

  const assigned = await db.user.findFirst({
    where: {
      id: assignedToUserId,
      OR: [{ admin: { is: { id: adminId } } }, { staff: { is: { adminId } } }],
    },
    select: { id: true },
  });

  if (!assigned) {
    throw new AppError(
      status.UNPROCESSABLE_ENTITY,
      "Assigned user does not belong to this business",
      {
        code: "LEAD_ACTIVITY_ASSIGNEE_INVALID",
        retryable: false,
        fieldErrors: { assignedToUserId: "Choose a user from this business." },
      },
    );
  }
};

const recomputeLastContactedAt = async (
  tx: Prisma.TransactionClient,
  leadId: string,
) => {
  const latest = await tx.leadActivity.findFirst({
    where: {
      leadId,
      status: "COMPLETED",
      type: { in: [...CONTACT_TYPES] },
      completedAt: { not: null },
    },
    select: { completedAt: true },
    orderBy: { completedAt: "desc" },
  });

  await tx.lead.update({
    where: { id: leadId },
    data: { lastContactedAt: latest?.completedAt ?? null },
  });
};

export interface FollowUpQuery {
  date?: string;
  from?: string;
  to?: string;
  assignedTo?: string;
  status?: LeadActivityStatusInput | "ALL";
  scope?: "today" | "overdue" | "upcoming";
  page?: number | string;
  limit?: number | string;
  sort?: "asc" | "desc";
}

const validTimeZone = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "UTC";
  }
};

const dateKeyInZone = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
};

const addDaysToDateKey = (dateKey: string, days: number): string => {
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
};

const localMidnightToUtc = (dateKey: string, timeZone: string): Date => {
  const [year, month, day] = dateKey.split("-").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const offsetAt = (instant: Date) => {
    const parts = formatter.formatToParts(instant);
    const number = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const represented = Date.UTC(
      number("year"),
      number("month") - 1,
      number("day"),
      number("hour") % 24,
      number("minute"),
      number("second"),
    );
    return represented - instant.getTime();
  };
  const guess = new Date(localAsUtc);
  let utc = new Date(localAsUtc - offsetAt(guess));
  // Re-evaluate once so boundaries remain correct around DST transitions.
  utc = new Date(localAsUtc - offsetAt(utc));
  return utc;
};

const followUpSelect = {
  id: true,
  leadId: true,
  type: true,
  status: true,
  scheduledAt: true,
  completedAt: true,
  assignedToUserId: true,
  note: true,
  outcome: true,
  createdAt: true,
  updatedAt: true,
  lead: {
    select: {
      id: true,
      leadRef: true,
      name: true,
      email: true,
      phone: true,
      stage: true,
      serviceInterest: true,
    },
  },
  assignedTo: { select: { id: true, name: true, email: true } },
} satisfies Prisma.LeadActivitySelect;

const getAdminTimezone = async (adminId: string): Promise<string> => {
  const cacheKey = `admin:tz:${adminId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return cached;

  const admin = await prisma.adminProfile.findFirst({
    where: { id: adminId },
    select: { businessHours: true },
  });
  if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");

  const businessHours = admin.businessHours as { timezone?: unknown } | null;
  const timeZone = validTimeZone(businessHours?.timezone);
  await redis.setex(cacheKey, 300, timeZone).catch(() => {});
  return timeZone;
};

const invalidateFollowUpsCache = async (adminId: string) => {
  await redis.incr(`followups:ver:${adminId}`).catch(() => {});
};

const getFollowUps = async (query: FollowUpQuery, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const timeZone = await getAdminTimezone(adminId);
  const now = new Date();
  const today = dateKeyInZone(now, timeZone);
  const todayStart = localMidnightToUtc(today, timeZone);
  const tomorrowStart = localMidnightToUtc(
    addDaysToDateKey(today, 1),
    timeZone,
  );

  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20) || 20));
  const sort = query.sort === "desc" ? "desc" : "asc";

  const version = (await redis.get(`followups:ver:${adminId}`).catch(() => null)) || "1";
  const filterKey = `${adminId}:v${version}:${query.scope ?? "today"}:${query.status ?? "PENDING"}:${query.assignedTo ?? "all"}:${query.date ?? ""}:${query.from ?? ""}:${query.to ?? ""}:${page}:${limit}:${sort}`;
  const cacheKey = `followups:${filterKey}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      /* ignore */
    }
  }

  const where: Prisma.LeadActivityWhereInput = {
    adminId,
    type: "FOLLOW_UP",
    scheduledAt: { not: null },
  };

  const statusFilter = query.status ?? "PENDING";
  if (statusFilter !== "ALL") where.status = statusFilter;
  if (query.assignedTo)
    where.assignedToUserId =
      query.assignedTo === "me" ? user.id : query.assignedTo;

  if (query.date) {
    where.scheduledAt = {
      gte: localMidnightToUtc(query.date, timeZone),
      lt: localMidnightToUtc(addDaysToDateKey(query.date, 1), timeZone),
    };
  } else if (query.from || query.to) {
    where.scheduledAt = {
      ...(query.from ? { gte: localMidnightToUtc(query.from, timeZone) } : {}),
      ...(query.to
        ? { lt: localMidnightToUtc(addDaysToDateKey(query.to, 1), timeZone) }
        : {}),
    };
  } else if (query.scope === "overdue") {
    where.scheduledAt = { lt: todayStart };
  } else if (query.scope === "upcoming") {
    where.scheduledAt = { gte: tomorrowStart };
  } else {
    // No explicit range means "today" in the business timezone, not the browser timezone.
    where.scheduledAt = { gte: todayStart, lt: tomorrowStart };
  }

  const [rows, total] = await Promise.all([
    prisma.leadActivity.findMany({
      where,
      select: followUpSelect,
      orderBy: [{ scheduledAt: sort }, { id: sort }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.leadActivity.count({ where }),
  ]);

  const result = {
    rows,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      timezone: timeZone,
      businessDate: today,
      scope:
        query.scope ??
        (query.date || query.from || query.to ? "custom" : "today"),
    },
  };

  await redis.setex(cacheKey, 60, JSON.stringify(result)).catch(() => {});
  return result;
};

const getFollowUpCalendar = async (
  query: Pick<FollowUpQuery, "from" | "to" | "assignedTo" | "status">,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);
  const timeZone = await getAdminTimezone(adminId);
  const today = dateKeyInZone(new Date(), timeZone);
  const where: Prisma.LeadActivityWhereInput = {
    adminId,
    type: "FOLLOW_UP",
    scheduledAt: {
      gte: localMidnightToUtc(query.from!, timeZone),
      lt: localMidnightToUtc(addDaysToDateKey(query.to!, 1), timeZone),
    },
  };
  const statusFilter = query.status ?? "PENDING";
  if (statusFilter !== "ALL") where.status = statusFilter;
  if (query.assignedTo)
    where.assignedToUserId =
      query.assignedTo === "me" ? user.id : query.assignedTo;

  // Month/calendar reads are date-scoped and use the compact follow-up DTO.
  // The hard cap protects a pathological tenant while avoiding a client-side `limit=500` fetch.
  const rows = await prisma.leadActivity.findMany({
    where,
    select: followUpSelect,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: 1000,
  });

  return {
    rows,
    meta: {
      timezone: timeZone,
      businessDate: today,
      from: query.from!,
      to: query.to!,
      truncated: rows.length === 1000,
    },
  };
};

const getActivities = async (leadId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  await ensureLead(prisma, adminId, leadId);

  return prisma.leadActivity.findMany({
    where: { leadId, adminId },
    include: activityInclude,
    orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
};

const createActivity = async (
  leadId: string,
  payload: LeadActivityCreatePayload,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  const result = await prisma.$transaction(async (tx) => {
    await ensureLead(tx, adminId, leadId);
    await ensureLeadActivityAssignee(tx, adminId, payload.assignedToUserId);

    const activityStatus = payload.status ?? "PENDING";
    const activity = await tx.leadActivity.create({
      data: {
        adminId,
        leadId,
        type: payload.type,
        status: activityStatus,
        scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : null,
        completedAt: activityStatus === "COMPLETED" ? new Date() : null,
        assignedToUserId: payload.assignedToUserId ?? null,
        note: payload.note?.trim() || null,
        outcome: payload.outcome?.trim() || null,
        createdBy: user.id,
      },
      include: activityInclude,
    });

    await recomputeLastContactedAt(tx, leadId);
    return activity;
  });

  await invalidateFollowUpsCache(adminId);
  return result;
};

const updateActivity = async (
  leadId: string,
  activityId: string,
  payload: LeadActivityUpdatePayload,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  const result = await prisma.$transaction(async (tx) => {
    await ensureLead(tx, adminId, leadId);
    const existing = await tx.leadActivity.findFirst({
      where: { id: activityId, leadId, adminId },
    });
    if (!existing)
      throw new AppError(status.NOT_FOUND, "Lead activity not found");

    if (payload.assignedToUserId !== undefined) {
      await ensureLeadActivityAssignee(tx, adminId, payload.assignedToUserId);
    }

    const nextStatus = payload.status ?? existing.status;
    const completedAt =
      nextStatus === "COMPLETED" ? (existing.completedAt ?? new Date()) : null;

    const activity = await tx.leadActivity.update({
      where: { id: activityId },
      data: {
        ...(payload.type !== undefined ? { type: payload.type } : {}),
        ...(payload.status !== undefined
          ? { status: payload.status, completedAt }
          : {}),
        ...(payload.scheduledAt !== undefined
          ? {
              scheduledAt: payload.scheduledAt
                ? new Date(payload.scheduledAt)
                : null,
            }
          : {}),
        ...(payload.assignedToUserId !== undefined
          ? { assignedToUserId: payload.assignedToUserId }
          : {}),
        ...(payload.note !== undefined
          ? { note: payload.note?.trim() || null }
          : {}),
        ...(payload.outcome !== undefined
          ? { outcome: payload.outcome?.trim() || null }
          : {}),
      },
      include: activityInclude,
    });

    await recomputeLastContactedAt(tx, leadId);
    return activity;
  });

  await invalidateFollowUpsCache(adminId);
  return result;
};

const deleteActivity = async (
  leadId: string,
  activityId: string,
  user: IRequestUser,
) => {
  const adminId = await getAdminId(user);

  await prisma.$transaction(async (tx) => {
    await ensureLead(tx, adminId, leadId);
    const existing = await tx.leadActivity.findFirst({
      where: { id: activityId, leadId, adminId },
      select: { id: true },
    });
    if (!existing) return;

    await tx.leadActivity.delete({ where: { id: activityId } });
    await recomputeLastContactedAt(tx, leadId);
  });

  await invalidateFollowUpsCache(adminId);
};

export const leadActivityService = {
  getFollowUps,
  getFollowUpCalendar,
  getActivities,
  createActivity,
  updateActivity,
  deleteActivity,
};
