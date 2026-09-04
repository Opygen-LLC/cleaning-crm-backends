import status from "http-status";
import type { Request, Response } from "express";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { resolveTenant, TenantAdminService } from "./tenantAdmin.service";
import { TenantEntitlementService } from "./tenantEntitlement.service";
import { SupportModeService, SUPPORT_MODE_COOKIE } from "./supportMode.service";
import { tokenUtils } from "../../lib/utils/token";

const actor = (req: Request) => req.user.id;
const context = (req: Request) => ({ actorUserId: actor(req), reason: String(req.body.reason ?? ""), ipAddress: req.ip ?? null, userAgent: req.get("user-agent") ?? null });
const ok = (res: Response, message: string, data: unknown) => sendResponse(res, { httpStatusCode: status.OK, success: true, message, data });

const getTenants = catchAsync(async (req, res) => ok(res, "Tenants retrieved successfully", await TenantAdminService.getTenants(req.query as Record<string, unknown>)));
const getTenantsHealth = catchAsync(async (_req, res) => ok(res, "Tenant health retrieved successfully", await TenantAdminService.getTenantsHealth()));
const getTenant = catchAsync(async (req, res) => ok(res, "Tenant details retrieved successfully", await TenantAdminService.getTenant360(req.params.adminId as string)));
const getTenantTeam = catchAsync(async (req, res) => ok(res, "Tenant team retrieved successfully", await TenantAdminService.getTenantTeam(req.params.adminId as string, req.query as Record<string, unknown>)));
const getTenantAudit = catchAsync(async (req, res) => ok(res, "Tenant audit retrieved successfully", await TenantAdminService.getTenantAudit(req.params.adminId as string, req.query as Record<string, unknown>)));
const getTenantBilling = catchAsync(async (req, res) => ok(res, "Tenant billing retrieved successfully", await TenantAdminService.getTenantBilling(req.params.adminId as string, req.query as Record<string, unknown>)));
const getTenantActivity = catchAsync(async (req, res) => ok(res, "Tenant activity retrieved successfully", await TenantAdminService.getTenantActivity(req.params.adminId as string, req.query as Record<string, unknown>)));
const getTenantSessions = catchAsync(async (req, res) => ok(res, "Tenant sessions retrieved successfully", await TenantAdminService.getTenantSessions(req.params.adminId as string, req.query as Record<string, unknown>)));
const revokeOwnerTenantSessions = catchAsync(async (req, res) => ok(res, "Owner sessions revoked successfully", await TenantAdminService.revokeOwnerTenantSessions(req.params.adminId as string, context(req))));
const revokeAllTenantSessions = catchAsync(async (req, res) => ok(res, "Tenant sessions revoked successfully", await TenantAdminService.revokeAllTenantSessions(req.params.adminId as string, context(req))));
const updateProfile = catchAsync(async (req, res) => { const { reason: _reason, ...payload } = req.body; ok(res, "Tenant profile updated successfully", await TenantAdminService.updateTenantProfile(req.params.adminId as string, payload, context(req))); });
const updateOwner = catchAsync(async (req, res) => { const { reason: _reason, ...payload } = req.body; ok(res, "Tenant owner updated successfully", await TenantAdminService.updateTenantOwner(req.params.adminId as string, payload, context(req))); });
const suspend = catchAsync(async (req, res) => ok(res, "Tenant suspended successfully", await TenantAdminService.suspendTenant(req.params.adminId as string, context(req))));
const reactivate = catchAsync(async (req, res) => ok(res, "Tenant reactivated successfully", await TenantAdminService.reactivateTenant(req.params.adminId as string, context(req))));
const archive = catchAsync(async (req, res) => ok(res, "Tenant archived successfully", await TenantAdminService.archiveTenant(req.params.adminId as string, context(req))));
const restore = catchAsync(async (req, res) => ok(res, "Tenant restored successfully", await TenantAdminService.restoreTenant(req.params.adminId as string, context(req))));
const deletionPreview = catchAsync(async (req, res) => ok(res, "Tenant deletion preview retrieved successfully", await TenantAdminService.getTenantDeletionPreview(req.params.adminId as string)));
const hardDelete = catchAsync(async (req, res) => ok(res, "Tenant permanently deleted", await TenantAdminService.hardDeleteTenant(req.params.adminId as string, req.body, context(req))));

const getUsers = catchAsync(async (req, res) => ok(res, "Users retrieved successfully", await TenantAdminService.getGlobalUsers(req.query as Record<string, unknown>)));
const getUsersSummary = catchAsync(async (_req, res) => ok(res, "User summary retrieved successfully", await TenantAdminService.getGlobalUsersSummary()));
const exportUsers = catchAsync(async (req, res) => { const csv = await TenantAdminService.exportGlobalUsersCsv(req.query as Record<string, unknown>); res.status(status.OK).setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", `attachment; filename="cleancrm-users-${new Date().toISOString().slice(0,10)}.csv"`); res.send(csv); });
const changeRole = catchAsync(async (req, res) => ok(res, "User role updated successfully", await TenantAdminService.updateGlobalUserRole(req.params.id as string, req.body.role, context(req))));
const changeStatus = catchAsync(async (req, res) => ok(res, "User status updated successfully", await TenantAdminService.updateGlobalUserStatus(req.params.id as string, req.body.status, context(req))));
const verify = catchAsync(async (req, res) => ok(res, "User manually verified successfully", await TenantAdminService.verifyGlobalUser(req.params.id as string, context(req))));


const startSupportMode = catchAsync(async (req, res) => {
  const result = await SupportModeService.start({
    supportAdminId: actor(req),
    organizationId: req.body.organizationId,
    reason: req.body.reason,
    durationMinutes: req.body.durationMinutes,
    ipAddress: req.ip,
    userAgent: typeof req.get === "function" ? req.get("user-agent") : undefined,
  });
  const expiresInMs = Math.max(60_000, new Date(result.session.expiresAt).getTime() - Date.now());
  tokenUtils.setSupportModeCookie(res, result.token, expiresInMs);
  tokenUtils.setRoleHintCookie(res, "ADMIN");
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
  return ok(res, "Read-only support mode started", result.session);
});

const currentSupportMode = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
  const token = req.cookies?.[SUPPORT_MODE_COOKIE];
  if (!token) return ok(res, "No active support mode", null);
  try {
    const session = await SupportModeService.current(token, actor(req));
    return ok(res, "Active support mode retrieved", session);
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && Number((error as { statusCode?: number }).statusCode) === status.UNAUTHORIZED) {
      tokenUtils.clearSupportModeCookie(res);
      tokenUtils.setRoleHintCookie(res, "SUPER_ADMIN");
      return ok(res, "No active support mode", null);
    }
    throw error;
  }
});

const endSupportMode = catchAsync(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
  const token = req.cookies?.[SUPPORT_MODE_COOKIE];
  if (!token) {
    tokenUtils.clearSupportModeCookie(res);
    tokenUtils.setRoleHintCookie(res, "SUPER_ADMIN");
    return ok(res, "Support mode already ended", { ended: false });
  }
  try {
    const result = await SupportModeService.end(token, actor(req), { ipAddress: req.ip, userAgent: typeof req.get === "function" ? req.get("user-agent") : undefined });
    tokenUtils.clearSupportModeCookie(res);
    tokenUtils.setRoleHintCookie(res, "SUPER_ADMIN");
    return ok(res, "Read-only support mode ended", result);
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && Number((error as { statusCode?: number }).statusCode) === status.UNAUTHORIZED) {
      tokenUtils.clearSupportModeCookie(res);
      tokenUtils.setRoleHintCookie(res, "SUPER_ADMIN");
      return ok(res, "Support mode already expired or ended", { ended: false });
    }
    throw error;
  }
});

const auditLogs = catchAsync(async (req, res) => ok(res, "Super Admin audit logs retrieved successfully", await TenantAdminService.getSuperAdminAuditLogs(req.query as Record<string, unknown>)));
const auditStats = catchAsync(async (_req, res) => ok(res, "Super Admin audit stats retrieved successfully", await TenantAdminService.getSuperAdminAuditStats()));

const subscriptionRequests = catchAsync(async (req, res) => ok(res, "Subscription requests retrieved successfully", await TenantAdminService.getSubscriptionRequests(req.query as Record<string, unknown>)));
const approveSubscriptionRequest = catchAsync(async (req, res) => ok(res, "Subscription request approved successfully", await TenantAdminService.approveSubscriptionRequest(req.params.id as string, context(req))));
const rejectSubscriptionRequest = catchAsync(async (req, res) => ok(res, "Subscription request rejected successfully", await TenantAdminService.rejectSubscriptionRequest(req.params.id as string, context(req))));
const changePlan = catchAsync(async (req, res) => ok(res, "Tenant plan changed successfully", await TenantAdminService.changeTenantPlan(req.params.adminId as string, req.body.targetPlanId, context(req))));
const scheduleDowngrade = catchAsync(async (req, res) => ok(res, "Tenant downgrade scheduled successfully", await TenantAdminService.scheduleTenantDowngrade(req.params.adminId as string, req.body.targetPlanId, context(req))));
const cancelScheduled = catchAsync(async (req, res) => ok(res, "Scheduled tenant plan change cancelled", await TenantAdminService.cancelScheduledTenantChange(req.params.adminId as string, context(req))));
const cancellation = catchAsync(async (req, res) => ok(res, req.body.cancelAtPeriodEnd ? "Cancellation scheduled" : "Cancellation removed", await TenantAdminService.setTenantCancelAtPeriodEnd(req.params.adminId as string, req.body.cancelAtPeriodEnd, context(req))));
const trial = catchAsync(async (req, res) => { const { reason: _reason, ...input } = req.body; ok(res, "Tenant trial updated successfully", await TenantAdminService.manageTenantTrial(req.params.adminId as string, input, context(req))); });
const getEntitlements = catchAsync(async (req, res) => { const tenant = await resolveTenant(req.params.adminId as string); ok(res, "Tenant entitlement override retrieved", await TenantEntitlementService.getTenantEntitlementOverride(tenant.id)); });
const setEntitlements = catchAsync(async (req, res) => ok(res, "Tenant entitlement override saved", await TenantAdminService.setTenantEntitlements(req.params.adminId as string, req.body, context(req))));
const revokeEntitlements = catchAsync(async (req, res) => ok(res, "Tenant entitlement override revoked", await TenantAdminService.revokeTenantEntitlements(req.params.adminId as string, context(req))));

export const tenantAdminController = { getTenants, getTenantsHealth, getTenant, getTenantTeam, getTenantAudit, getTenantBilling, getTenantActivity, getTenantSessions, revokeOwnerTenantSessions, revokeAllTenantSessions, startSupportMode, currentSupportMode, endSupportMode, updateProfile, updateOwner, suspend, reactivate, archive, restore, deletionPreview, hardDelete, getUsers, getUsersSummary, exportUsers, changeRole, changeStatus, verify, auditLogs, auditStats, subscriptionRequests, approveSubscriptionRequest, rejectSubscriptionRequest, changePlan, scheduleDowngrade, cancelScheduled, cancellation, trial, getEntitlements, setEntitlements, revokeEntitlements };
