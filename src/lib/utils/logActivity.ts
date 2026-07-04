import { prisma } from "../prisma/prisma";
import { Prisma } from "../../generated/prisma/client";

// ─── Activity log ──────────────────────────────────────────────────────────────
//
// ActivityLog.adminId is a foreign key to AdminProfile (see
// prisma/schema/activityLog.prisma) — this table is the super-admin-visible
// audit trail of what TENANT ADMINS do inside their own CRM (create a
// booking, delete a client, mark an invoice paid, etc.), not of the
// super-admin's own platform-management actions. A super-admin doesn't have
// an AdminProfile row, so their actions (plan CRUD, account suspension,
// payment-proof review, refunds, platform config changes) cannot be written
// to this table as-is.
//
// Before this file existed, createActivityLog() was defined in
// superAdmin.service.ts but had ZERO call sites anywhere in the codebase —
// every tenant-admin mutation skipped logging entirely, so
// GET /super-admin/activity-logs only ever showed whatever was manually
// seeded. This helper + its call sites in the money/scheduling-critical
// services (Invoice, Booking, Staff — see individual service files) is the
// fix for that.
//
// To extend coverage: call logActivity(...) from any other tenant-admin
// mutation (Client, Coupon, EstimateForm, BookingForm, etc.) using the same
// pattern — resolve the AdminProfile id you already have in scope, then
// fire-and-forget log the action. Never await this in a way that can fail
// the parent request; logging a failure should never break the actual
// mutation.
//
// To also capture super-admin's own actions, the cleanest path is a schema
// change: either make ActivityLog.adminId nullable and add an
// `actorType: "ADMIN" | "SUPER_ADMIN"` + `actorUserId` column, or add a
// separate SuperAdminActivityLog table with the same shape keyed on
// User.id instead of AdminProfile.id. That's a migration, so it's called
// out here rather than silently bolted on.

export interface LogActivityPayload {
    adminId: string;
    action: string; // e.g. "CREATE_INVOICE", "DELETE_BOOKING", "SUSPEND_STAFF"
    entityType: string; // e.g. "Invoice", "Booking", "Staff"
    entityId?: string;
    description: string;
    metadata?: Record<string, unknown>;
}

export async function logActivity(payload: LogActivityPayload): Promise<void> {
    try {
        await prisma.activityLog.create({
            data: {
                adminId: payload.adminId,
                action: payload.action,
                entityType: payload.entityType,
                entityId: payload.entityId,
                description: payload.description,
                metadata: payload.metadata as
                    | Prisma.InputJsonValue
                    | undefined,
            },
        });
    } catch (err) {
        // Never let a logging failure break the action it's documenting.
        console.error("[logActivity] Failed:", err);
    }
}
