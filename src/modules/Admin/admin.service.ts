// ─── PHASE 3 CHANGE ──────────────────────────────────────────────────────────
// Only `getAdminUsage` is modified in this file.
//
// Before: returned { staffCount, clientCount, bookingCountThisMonth }
// After:  returns the same counts PLUS the plan caps (and the plan/subscription
//         ids), so the frontend can render usage bars without a second round-trip
//         to /subscription/me.
//
// All other functions in admin.service.ts are unchanged — copy them from the
// original file verbatim.  Only this function is shown here.
// ─────────────────────────────────────────────────────────────────────────────

import { startOfMonth } from "date-fns";
import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";

export interface AdminUsageResponse {
  /** Real-time counts */
  staffCount: number;
  clientCount: number;
  bookingCountThisMonth: number;

  /**
   * Plan caps after applying any per-admin add-ons.
   * null means the plan is unlimited for that resource.
   */
  caps: {
    staff: number | null;
    clients: number | null;
    bookingsPerMonth: number | null;
  };

  /** Convenience: pct of each cap that is consumed (0-100, null if unlimited) */
  pct: {
    staff: number | null;
    clients: number | null;
    bookingsPerMonth: number | null;
  };

  /** True when any capped resource is >= 90% consumed */
  anyNearLimit: boolean;

  /** Snapshot ids for cache-busting on the client */
  subscriptionId: string | null;
  planId: string | null;
}

// ─── Get admin usage counts AND plan caps ─────────────────────────────────────

const getAdminUsage = async (userId: string): Promise<AdminUsageResponse> => {
  const admin = await prisma.adminProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!admin) {
    throw new AppError(404, "Admin profile not found");
  }

  const adminId = admin.id;
  const monthStart = startOfMonth(new Date());

  // ── Parallel: counts + latest subscription ─────────────────────────────────
  const [staffCount, clientCount, bookingCountThisMonth, sub] =
    await Promise.all([
      prisma.staffProfile.count({
        where: { adminId, status: "ACTIVE" },
      }),
      prisma.client.count({
        where: { adminId, status: "ACTIVE" },
      }),
      prisma.booking.count({
        where: { adminId, createdAt: { gte: monthStart } },
      }),
      prisma.subscription.findFirst({
        where: { adminId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          extraStaff: true,
          extraClient: true,
          extraBookingsPerMonth: true,
          plan: {
            select: {
              id: true,
              maxStaff: true,
              maxClient: true,
              maxBookingsPerMonth: true,
            },
          },
        },
      }),
    ]);

  // ── Compute caps (null = unlimited) ────────────────────────────────────────
  //
  // When there is no subscription row (free trial / super-admin created
  // account) we return null caps so the frontend shows "Unlimited" bars.
  let caps: AdminUsageResponse["caps"] = {
    staff: null,
    clients: null,
    bookingsPerMonth: null,
  };

  if (sub) {
    const addExtra = (
      base: number | null | undefined,
      extra: number,
    ): number | null => {
      if (base === null || base === undefined) return null;
      return base + extra;
    };

    caps = {
      staff: addExtra(sub.plan.maxStaff, sub.extraStaff),
      clients: addExtra(sub.plan.maxClient, sub.extraClient),
      bookingsPerMonth: addExtra(
        sub.plan.maxBookingsPerMonth,
        sub.extraBookingsPerMonth,
      ),
    };
  }

  // ── Compute percentages ────────────────────────────────────────────────────
  const toPct = (count: number, cap: number | null): number | null => {
    if (cap === null || cap === 0) return null;
    return Math.min(Math.round((count / cap) * 100), 100);
  };

  const pct: AdminUsageResponse["pct"] = {
    staff: toPct(staffCount, caps.staff),
    clients: toPct(clientCount, caps.clients),
    bookingsPerMonth: toPct(bookingCountThisMonth, caps.bookingsPerMonth),
  };

  const anyNearLimit = [pct.staff, pct.clients, pct.bookingsPerMonth].some(
    (p) => p !== null && p >= 90,
  );

  return {
    staffCount,
    clientCount,
    bookingCountThisMonth,
    caps,
    pct,
    anyNearLimit,
    subscriptionId: sub?.id ?? null,
    planId: sub?.plan.id ?? null,
  };
};

export { getAdminUsage };
