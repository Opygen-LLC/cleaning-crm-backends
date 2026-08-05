/**
 * job.dispatch.service.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Auto-dispatch / smart-assign engine  (Phase 1 — missing feature)
 *
 * Strategy (weighted scoring, O(staff × jobs)):
 *   1. Filter out busy staff  (hard conflict on the scheduled window)
 *   2. Prefer staff whose specialty matches the job's serviceType
 *   3. Prefer staff with fewer jobs on the same day   (load balancing)
 *   4. Prefer staff with lower total hours this week  (fatigue balancing)
 *   5. Prefer staff already assigned to this client   (continuity)
 *
 * Returns the top-N recommended staff IDs so the controller can either
 * auto-assign them or surface them to the admin for confirmation.
 */

import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { JobStatus, ServiceType } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";

// ─── Scoring weights ──────────────────────────────────────────────────────────

const W_SPECIALTY   = 40;   // staff specialty matches job service type
const W_CONTINUITY  = 25;   // staff has worked with this client before
const W_DAILY_LOAD  = 20;   // fewer jobs today  → higher score
const W_WEEKLY_LOAD = 15;   // fewer hours this week → higher score

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

/** Map prisma ServiceType enum values → human-readable keywords for matching */
const serviceKeywords: Partial<Record<ServiceType, string[]>> = {
    [ServiceType.RESIDENTIAL_CLEAN]: ["residential", "clean"],
    [ServiceType.DEEP_CLEAN]:        ["deep", "clean"],
    [ServiceType.OFFICE_CLEAN]:      ["office", "clean"],
    [ServiceType.END_OF_TENANCY]:    ["tenancy", "eot", "end"],
    [ServiceType.CARPET_CLEAN]:      ["carpet"],
    [ServiceType.WINDOW_CLEAN]:      ["window"],
    [ServiceType.MOVE_IN_OUT_CLEAN]: ["move", "in", "out"],
};

function specialtyMatchScore(staffSpecialties: string[] | undefined | null, jobType: ServiceType): number {
    const keywords = serviceKeywords[jobType] ?? [];
    if (keywords.length === 0 || !staffSpecialties) return 0;
    const lower = (staffSpecialties ?? []).map((s) => s.toLowerCase());
    const matched = keywords.some((kw) => lower.some((sp) => sp.includes(kw)));
    return matched ? W_SPECIALTY : 0;
}


// ─── Core scoring function ────────────────────────────────────────────────────

export interface DispatchRecommendation {
    staffId:        string;
    name:           string;
    email:          string;
    score:          number;
    reasons:        string[];
    available:      boolean;
    conflictingJobs: {
        jobId:        string;
        jobRef:       string;
        clientName:   string;
        scheduledDate: Date;
        durationMins: number;
    }[];
}

export interface AutoDispatchResult {
    jobId:           string;
    jobRef:          string;
    scheduledDate:   Date;
    durationMins:    number;
    serviceType:     ServiceType;
    recommendations: DispatchRecommendation[];
    autoAssigned:    boolean;
    assignedStaffIds: string[];
}

export interface AutoDispatchOptions {
    /** How many staff to assign automatically. Defaults to 1. */
    count?: number;
    /**
     * If true, the engine will actually write the JobStaffAssignment records.
     * If false (default), it only returns recommendations.
     */
    commit?: boolean;
}

// ─── Main service function ────────────────────────────────────────────────────

const autoDispatch = async (
    jobId: string,
    user: IRequestUser,
    options: AutoDispatchOptions = {},
): Promise<AutoDispatchResult> => {
    const { count = 1, commit = false } = options;

    const adminId = await resolveAdminId(user.id);

    // 1. Load the job
    const job = await prisma.job.findFirst({
        where: { id: jobId, adminId },
        include: {
            client: { select: { id: true, name: true } },
            staffAssignments: { select: { staffId: true } },
        },
    });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found");

    const windowStart = job.scheduledDate.getTime();
    const windowEnd   = windowStart + job.durationMins * 60_000;

    // 2. Load all active staff for this admin
    const allStaff = await prisma.staffProfile.findMany({
        where:   { adminId, status: "ACTIVE" },
        include: {
            user: { select: { id: true, name: true, email: true } },
        },
    });

    // 3. Load all scheduled/in-progress jobs to detect conflicts & daily/weekly load
    const dayStart = new Date(job.scheduledDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);

    const weekStart = new Date(dayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60_000);

    const activeJobs = await prisma.job.findMany({
        where: {
            adminId,
            status: { in: [JobStatus.SCHEDULED, JobStatus.IN_PROGRESS] },
            id:     { not: jobId }, // exclude the target job itself
        },
        include: {
            staffAssignments: { select: { staffId: true } },
            client:           { select: { name: true } },
        },
    });

    // Build per-staff maps
    const conflictMap  = new Map<string, typeof activeJobs>();
    const dailyJobMap  = new Map<string, number>();  // staffId → count today
    const weeklyMins   = new Map<string, number>();  // staffId → total mins this week

    for (const j of activeJobs) {
        const jStart = j.scheduledDate.getTime();
        const jEnd   = jStart + j.durationMins * 60_000;
        const isConflict = jStart < windowEnd && jEnd > windowStart;
        const isToday    = j.scheduledDate >= dayStart && j.scheduledDate < dayEnd;
        const isThisWeek = j.scheduledDate >= weekStart && j.scheduledDate < weekEnd;

        for (const { staffId } of j.staffAssignments) {
            if (isConflict) {
                if (!conflictMap.has(staffId)) conflictMap.set(staffId, []);
                conflictMap.get(staffId)!.push(j);
            }
            if (isToday) {
                dailyJobMap.set(staffId, (dailyJobMap.get(staffId) ?? 0) + 1);
            }
            if (isThisWeek) {
                weeklyMins.set(staffId, (weeklyMins.get(staffId) ?? 0) + j.durationMins);
            }
        }
    }

    // 4. Load past job history for this client (continuity scoring)
    const clientJobStaff = await prisma.jobStaffAssignment.findMany({
        where: {
            job: { clientId: job.client.id, adminId },
        },
        select: { staffId: true },
    });
    const clientStaffIds = new Set(clientJobStaff.map((r) => r.staffId));

    // 5. Score every staff member
    const maxDailyJobs  = Math.max(...[...dailyJobMap.values(), 1]);
    const maxWeeklyMins = Math.max(...[...weeklyMins.values(), 1]);

    const alreadyAssigned = new Set(job.staffAssignments.map((a) => a.staffId));

    const scored: DispatchRecommendation[] = allStaff.map((staff) => {
        const conflicts = conflictMap.get(staff.id) ?? [];
        const available = conflicts.length === 0;
        const reasons:   string[] = [];
        let   score = 0;

        if (!available) {
            score = -9999; // hard exclusion unless we allow override
        } else {
            // Specialty match
            const specialtyScore = specialtyMatchScore(staff.specialty, job.serviceType);
            if (specialtyScore > 0) {
                score += specialtyScore;
                reasons.push("Specialty match");
            }

            // Client continuity
            if (clientStaffIds.has(staff.id)) {
                score += W_CONTINUITY;
                reasons.push("Previous client experience");
            }

            // Daily load (inverse — fewer jobs = higher score)
            const daily = dailyJobMap.get(staff.id) ?? 0;
            const dailyScore = Math.round(W_DAILY_LOAD * (1 - daily / maxDailyJobs));
            score += dailyScore;
            if (daily === 0) reasons.push("Free today");

            // Weekly load (inverse)
            const weekly = weeklyMins.get(staff.id) ?? 0;
            const weeklyScore = Math.round(W_WEEKLY_LOAD * (1 - weekly / maxWeeklyMins));
            score += weeklyScore;

            if (alreadyAssigned.has(staff.id)) {
                score = -1; // already assigned — keep in list but de-rank
                reasons.push("Already assigned");
            }
        }

        return {
            staffId:   staff.id,
            name:      staff.user.name,
            email:     staff.user.email,
            score,
            reasons,
            available,
            conflictingJobs: conflicts.map((j) => ({
                jobId:         j.id,
                jobRef:        j.jobRef,
                clientName:    j.client.name,
                scheduledDate: j.scheduledDate,
                durationMins:  j.durationMins,
            })),
        };
    });

    // Sort: highest score first, then alphabetically
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    // 6. Optionally commit the top-N available staff
    let autoAssigned    = false;
    let assignedStaffIds: string[] = [];

    if (commit) {
        const toAssign = scored
            .filter((s) => s.available && s.score >= 0)
            .slice(0, count)
            .map((s) => s.staffId);

        if (toAssign.length > 0) {
            await prisma.$transaction(async (tx) => {
                // Remove current assignments first (full replace)
                await tx.jobStaffAssignment.deleteMany({ where: { jobId } });
                await tx.jobStaffAssignment.createMany({
                    data: toAssign.map((staffId) => ({ jobId, staffId })),
                });
            });
            autoAssigned     = true;
            assignedStaffIds = toAssign;
        }
    }

    return {
        jobId,
        jobRef:          job.jobRef,
        scheduledDate:   job.scheduledDate,
        durationMins:    job.durationMins,
        serviceType:     job.serviceType,
        recommendations: scored,
        autoAssigned,
        assignedStaffIds,
    };
};

/**
 * Bulk auto-dispatch: run the engine across all unassigned scheduled jobs
 * for this admin. Returns a per-job summary useful for the admin dashboard.
 */
const bulkAutoDispatch = async (
    user: IRequestUser,
    options: AutoDispatchOptions = {},
): Promise<AutoDispatchResult[]> => {
    const adminId = await resolveAdminId(user.id);

    const unassignedJobs = await prisma.job.findMany({
        where: {
            adminId,
            status: JobStatus.SCHEDULED,
            staffAssignments: { none: {} },
        },
        select: { id: true },
        orderBy: { scheduledDate: "asc" },
    });

    // PERF FIX (Phase 2.1): this used to await autoDispatch() one job at a
    // time in a plain for-loop — each call does several DB round-trips
    // internally, so dispatching N unassigned jobs took N sequential
    // round-trips end to end (the slowest single operation found in the
    // audit: a 50-job bulk dispatch ran 50x slower than necessary).
    //
    // Fixed by running in small concurrent batches instead of either fully
    // sequential (too slow) or fully unbounded parallel (would flood the
    // Prisma connection pool, which is capped at 10 — see prisma.ts). A
    // batch size of 5 leaves headroom for other concurrent requests hitting
    // the same pool while still cutting wall-clock time dramatically.
    const BULK_DISPATCH_CONCURRENCY = 5;
    const results: AutoDispatchResult[] = [];

    for (let i = 0; i < unassignedJobs.length; i += BULK_DISPATCH_CONCURRENCY) {
        const batch = unassignedJobs.slice(i, i + BULK_DISPATCH_CONCURRENCY);
        const batchResults = await Promise.allSettled(
            batch.map(({ id }) => autoDispatch(id, user, options)),
        );
        for (const outcome of batchResults) {
            if (outcome.status === "fulfilled") {
                results.push(outcome.value);
            }
            // rejected → log & skip, same behavior as before (don't break the bulk run)
        }
    }

    return results;
};


export const jobDispatchService = {
    autoDispatch,
    bulkAutoDispatch,
};
