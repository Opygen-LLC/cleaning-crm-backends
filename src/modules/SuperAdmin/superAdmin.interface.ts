// ─── Activity Logs ────────────────────────────────────────────────────────────

export interface IActivityLogFilters {
    searchTerm?: string;
    action?: string;
    entityType?: string;
    adminId?: string;
    startDate?: string;
    endDate?: string;
}

// ─── Admin Accounts ───────────────────────────────────────────────────────────

export interface IAdminAccountFilters {
    searchTerm?: string;
    status?: string;
    subscriptionStatus?: string;
}

// ─── Billing History ──────────────────────────────────────────────────────────

export interface IBillingHistoryFilters {
    adminId?: string;
    subscriptionId?: string;
    startDate?: string;
    endDate?: string;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

export interface ISubscriptionFilters {
    status?: string;
    planId?: string;
    isTrial?: string;
}

// ─── Manual Payment (grant by super admin) ────────────────────────────────────

export type TManualPaymentMethod =
    | "CASH"
    | "BANK_TRANSFER"
    | "CHEQUE"
    | "MANUAL";

export interface IGrantManualPaymentPayload {
    amount: number;
    method: TManualPaymentMethod;
    note?: string;
    transactionId?: string;
    /** How many months to extend the subscription period. Defaults to 1. */
    periodMonths?: number;
}

// ─── Payment Proof Review (manual payment loop) ───────────────────────────────

export interface IApprovePaymentProofPayload {
    /** How many months to advance currentPeriodEnd. Defaults to 1. */
    periodMonths?: number;
    /** Optional note to store on the billing record (overwrites existing). */
    note?: string;
}

export interface IRejectPaymentProofPayload {
    /** Human-readable rejection reason stored in billingHistory.note. */
    reason?: string;
}

// ─── Platform Config ──────────────────────────────────────────────────────────

export interface IPlatformConfigPayload {
    trialDays?: number;
    defaultCurrency?: string;
    supportEmail?: string;
    [key: string]: unknown;
}

// ─── Revenue Dashboard ────────────────────────────────────────────────────────

export interface IRevenueDashboardFilters {
    startDate?: string;
    endDate?: string;
    interval?: "daily" | "weekly" | "monthly";
}
