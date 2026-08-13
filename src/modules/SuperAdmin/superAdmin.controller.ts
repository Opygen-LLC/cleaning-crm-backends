import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { superAdminService } from "./superAdmin.service";
import {
    IActivityLogFilters,
    IAdminAccountFilters,
} from "./superAdmin.interface";
import AppError from "../../errorHelper/AppError";

// ─── Platform Stats ───────────────────────────────────────────────────────────

const getPlatformStats = catchAsync(async (req, res) => {
    const result = await superAdminService.getPlatformStats();
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Platform stats retrieved successfully",
        data: result,
    });
});

// ─── Revenue ──────────────────────────────────────────────────────────────────

const getPlatformRevenueDashboard = catchAsync(async (req, res) => {
    const result = await superAdminService.getPlatformRevenueDashboard({
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        interval: req.query.interval as "daily" | "weekly" | "monthly",
    });
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Platform revenue dashboard retrieved successfully",
        data: result,
    });
});

// ─── Activity Logs ────────────────────────────────────────────────────────────

const getActivityLogs = catchAsync(async (req, res) => {
    const filters: IActivityLogFilters = {
        searchTerm: req.query.searchTerm as string,
        action: req.query.action as string,
        entityType: req.query.entityType as string,
        adminId: req.query.adminId as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
    };
    const paginationOptions = {
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit
            ? parseInt(req.query.limit as string)
            : undefined,
    };

    const result = await superAdminService.getActivityLogs(
        filters,
        paginationOptions,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Activity logs retrieved successfully",
        meta: result.meta,
        data: result.data,
    });
});

const getActivityLogStats = catchAsync(async (req, res) => {
    const result = await superAdminService.getActivityLogStats();
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Activity log stats retrieved successfully",
        data: result,
    });
});

// ─── Admin Accounts ───────────────────────────────────────────────────────────

const getAllAdminAccounts = catchAsync(async (req, res) => {
    const filters: IAdminAccountFilters = {
        searchTerm: req.query.searchTerm as string,
        status: req.query.status as string,
        subscriptionStatus: req.query.subscriptionStatus as string,
    };
    const paginationOptions = {
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit
            ? parseInt(req.query.limit as string)
            : undefined,
    };

    const result = await superAdminService.getAllAdminAccounts(
        filters,
        paginationOptions,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin accounts retrieved successfully",
        meta: result.meta,
        data: result.data,
    });
});

const getAdminAccountById = catchAsync(async (req, res) => {
    const result = await superAdminService.getAdminAccountById(
        req.params.adminId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin account retrieved successfully",
        data: result,
    });
});

const suspendAdminAccount = catchAsync(async (req, res) => {
    const result = await superAdminService.suspendAdminAccount(
        req.params.adminId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin account suspended successfully",
        data: result,
    });
});

const activateAdminAccount = catchAsync(async (req, res) => {
    const result = await superAdminService.activateAdminAccount(
        req.params.adminId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin account activated successfully",
        data: result,
    });
});

const createAdminAccount = catchAsync(async (req, res) => {
    const result = await superAdminService.createAdminAccount(req.body);
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Admin account created successfully",
        data: result,
    });
});

// ─── Subscription Plan CRUD ───────────────────────────────────────────────────

const getSubscriptionPlans = catchAsync(async (_req, res) => {
    const result = await superAdminService.getSuperAdminSubscriptionPlans();
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription plans retrieved successfully",
        data: result,
    });
});

const getSubscriptionPlanById = catchAsync(async (req, res) => {
    const result = await superAdminService.getSuperAdminSubscriptionPlanById(
        req.params.planId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription plan retrieved successfully",
        data: result,
    });
});

const createSubscriptionPlan = catchAsync(async (req, res) => {
    const result = await superAdminService.createSubscriptionPlan(req.body);
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Subscription plan created successfully",
        data: result,
    });
});

const updateSubscriptionPlan = catchAsync(async (req, res) => {
    const result = await superAdminService.updateSubscriptionPlan(
        req.params.planId as string,
        req.body,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription plan updated successfully",
        data: result,
    });
});

const updatePricingTier = catchAsync(async (req, res) => {
    const result = await superAdminService.updatePricingTier(
        req.params.tierId as string,
        req.body,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Pricing tier updated successfully",
        data: result,
    });
});

const deleteSubscriptionPlan = catchAsync(async (req, res) => {
    const result = await superAdminService.deleteSubscriptionPlan(
        req.params.planId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription plan deleted successfully",
        data: result,
    });
});

const toggleSubscriptionPlanStatus = catchAsync(async (req, res) => {
    const { isActive } = req.body as { isActive: boolean };
    const result = await superAdminService.toggleSubscriptionPlanStatus(
        req.params.planId as string,
        Boolean(isActive),
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Subscription plan ${isActive ? "activated" : "deactivated"} successfully`,
        data: result,
    });
});

// ─── Subscription Management ──────────────────────────────────────────────────

const getAllSubscriptions = catchAsync(async (req, res) => {
    const filters = {
        status: req.query.status as string,
        planId: req.query.planId as string,
        isTrial: req.query.isTrial as string,
        search: req.query.search as string,
        plan: req.query.plan as string,
        billingCycle: req.query.billingCycle as
            | "monthly"
            | "annual"
            | undefined,
        sortField: req.query.sortField as
            | "adminName"
            | "plan"
            | "status"
            | "mrr"
            | "billingCycle"
            | "startedAt"
            | "nextBillingDate"
            | undefined,
        sortDir: req.query.sortDir as "asc" | "desc" | undefined,
    };
    const paginationOptions = {
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit
            ? parseInt(req.query.limit as string)
            : undefined,
    };

    const result = await superAdminService.getAllSubscriptions(
        filters,
        paginationOptions,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscriptions retrieved successfully",
        meta: result.meta,
        data: result.data,
        stats: result.stats,
    });
});

const cancelSubscription = catchAsync(async (req, res) => {
    const result = await superAdminService.cancelSubscription(
        req.params.subscriptionId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription cancelled successfully",
        data: result,
    });
});

const getBillingHistory = catchAsync(async (req, res) => {
    const filters = {
        adminId: req.query.adminId as string,
        subscriptionId: req.query.subscriptionId as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
    };
    const paginationOptions = {
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit
            ? parseInt(req.query.limit as string)
            : undefined,
    };

    const result = await superAdminService.getBillingHistory(
        filters,
        paginationOptions,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Billing history retrieved successfully",
        meta: result.meta,
        data: result.data,
    });
});

const refundBillingRecord = catchAsync(async (req, res) => {
    const result = await superAdminService.refundBillingRecord(
        req.params.id as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Billing record marked as refunded.",
        data: result,
    });
});

const getBillingInvoice = catchAsync(async (req, res) => {
    const result = await superAdminService.getBillingInvoice(
        req.params.id as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Invoice URL retrieved.",
        data: result,
    });
});

const sendTrialNudge = catchAsync(async (req, res) => {
    const result = await superAdminService.sendTrialNudge(
        req.params.subscriptionId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Trial nudge email sent.",
        data: result,
    });
});

const getPlatformConfig = catchAsync(async (_req, res) => {
    const result = await superAdminService.getPlatformConfig();
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Platform config retrieved.",
        data: result,
    });
});

const updatePlatformConfig = catchAsync(async (req, res) => {
    const result = await superAdminService.updatePlatformConfig(req.body);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Platform config saved.",
        data: result,
    });
});

const grantManualPayment = catchAsync(async (req, res) => {
    const { subscriptionId } = req.params;
    const { amount, method, note, transactionId, periodMonths } = req.body as {
        amount: number;
        method: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "MANUAL";
        note?: string;
        transactionId?: string;
        periodMonths?: number;
    };

    if (!amount || !method) {
        throw new AppError(
            status.BAD_REQUEST,
            "amount and method are required.",
        );
    }

    const result = await superAdminService.grantManualPayment(
        subscriptionId as string,
        {
            amount,
            method,
            note,
            transactionId,
            periodMonths,
        },
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Payment granted and subscription activated successfully.",
        data: result,
    });
});

const suspendSubscription = catchAsync(async (req, res) => {
    const result = await superAdminService.suspendSubscription(
        req.params.subscriptionId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription suspended successfully.",
        data: result,
    });
});

const reactivateSubscription = catchAsync(async (req, res) => {
    const result = await superAdminService.reactivateSubscription(
        req.params.subscriptionId as string,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription reactivated successfully.",
        data: result,
    });
});

const extendTrial = catchAsync(async (req, res) => {
    const days = Number(req.body?.days);
    const result = await superAdminService.extendTrial(
        req.params.subscriptionId as string,
        days,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Trial extended by ${days} day(s) successfully.`,
        data: result,
    });
});

// ─── Payment Proof Review ─────────────────────────────────────────────────────

const getPendingProofs = catchAsync(async (req, res) => {
    const paginationOptions = {
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit
            ? parseInt(req.query.limit as string)
            : undefined,
    };

    const result = await superAdminService.getPendingProofs(paginationOptions);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Pending payment proofs retrieved successfully.",
        meta: result.meta,
        data: result.data,
    });
});

const approvePaymentProof = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { periodMonths, note } = req.body as {
        periodMonths?: number;
        note?: string;
    };

    const result = await superAdminService.approvePaymentProof(id as string, {
        periodMonths,
        note,
    });

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Payment proof approved. Subscription is now ACTIVE.",
        data: result,
    });
});

const rejectPaymentProof = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };

    const result = await superAdminService.rejectPaymentProof(id as string, {
        reason,
    });

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Payment proof rejected.",
        data: result,
    });
});

export const superAdminController = {
    getPlatformStats,
    getPlatformRevenueDashboard,
    getActivityLogs,
    getActivityLogStats,
    getAllAdminAccounts,
    getAdminAccountById,
    suspendAdminAccount,
    activateAdminAccount,
    createAdminAccount,
    getSubscriptionPlans,
    getSubscriptionPlanById,
    createSubscriptionPlan,
    updateSubscriptionPlan,
    updatePricingTier,
    deleteSubscriptionPlan,
    toggleSubscriptionPlanStatus,
    getAllSubscriptions,
    cancelSubscription,
    getBillingHistory,
    grantManualPayment,
    suspendSubscription,
    reactivateSubscription,
    extendTrial,
    refundBillingRecord,
    getBillingInvoice,
    sendTrialNudge,
    getPlatformConfig,
    updatePlatformConfig,
    // Payment proof review (manual payment loop)
    getPendingProofs,
    approvePaymentProof,
    rejectPaymentProof,
};
