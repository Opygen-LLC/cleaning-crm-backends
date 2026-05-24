/**
 * job.dispatch.controller.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * HTTP handlers for the auto-dispatch engine (Phase 1)
 */

import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { jobDispatchService } from "./job.dispatch.service";

/**
 * GET /job/:id/dispatch
 * Returns ranked recommendations for a single job (dry-run, no DB write).
 */
const getRecommendations = catchAsync(async (req, res) => {
    const result = await jobDispatchService.autoDispatch(
        req.params.id as string,
        req.user,
        { commit: false },
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message:        "Dispatch recommendations retrieved",
        data:           result,
    });
});

/**
 * POST /job/:id/dispatch
 * Auto-assigns the best available staff to a single job and writes to DB.
 * Body: { count?: number }
 */
const dispatchJob = catchAsync(async (req, res) => {
    const count = Number(req.body?.count ?? 1);

    const result = await jobDispatchService.autoDispatch(
        req.params.id as string,
        req.user,
        { count, commit: true },
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message: result.autoAssigned
            ? `Auto-dispatched ${result.assignedStaffIds.length} staff member(s)`
            : "No available staff found — no assignment made",
        data: result,
    });
});

/**
 * POST /job/dispatch/bulk
 * Auto-assigns the best available staff to ALL unassigned scheduled jobs.
 * Body: { count?: number, commit?: boolean }
 */
const bulkDispatch = catchAsync(async (req, res) => {
    const count  = Number(req.body?.count  ?? 1);
    const commit = Boolean(req.body?.commit ?? false);

    const results = await jobDispatchService.bulkAutoDispatch(req.user, {
        count,
        commit,
    });

    const assigned = results.filter((r) => r.autoAssigned).length;

    sendResponse(res, {
        httpStatusCode: status.OK,
        success:        true,
        message: commit
            ? `Bulk dispatch complete — ${assigned}/${results.length} jobs assigned`
            : `Bulk recommendations ready for ${results.length} unassigned job(s)`,
        data: results,
    });
});

export const jobDispatchController = {
    getRecommendations,
    dispatchJob,
    bulkDispatch,
};
