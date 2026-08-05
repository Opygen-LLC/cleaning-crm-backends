/**
 * job.dispatch.service.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Auto-dispatch / smart-assign engine
 *
 * Strategy (weighted scoring, O(staff × jobs)):
 *   1. Filter out busy staff  (hard conflict on the scheduled window)
 *   2. Prefer staff whose specialty matches the job's serviceType
 *   3. Prefer staff close to the job / with a short estimated commute (Phase 2)
 *   4. Prefer staff with fewer jobs on the same day   (load balancing)
 *   5. Prefer staff with lower total hours this week  (fatigue balancing)
 *   6. Prefer staff already assigned to this client   (continuity)
 *
 * Phase 2 — location-aware dispatch: proximity is scored from straight-line
 * (haversine) distance between the staff member's geocoded address and the
 * job's geocoded address, converted to an estimated drive time. Distance is
 * used instead of a routing API for the scoring pass because it runs once
 * per (staff × job) pair — see src/lib/utils/geo.ts for the tradeoff. Staff
 * or jobs without coordinates yet (not geocoded, or address unresolved)
 * simply don't receive a proximity score or penalty — they're neither
 * boosted nor excluded, so the feature degrades gracefully while an admin's
 * data is still being backfilled.
 *
 * Returns the top-N recommended staff IDs so the controller can either
 * auto-assign them or surface them to the admin for confirmation.
 */

import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { JobStatus, ServiceType } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import {
    haversineDistanceKm,
    estimateTravelMins,
    isValidLatLng,
} from "../../lib/utils/geo";

// ─── Scoring weights ──────────────────────────────────────────────────────────

const W_SPECIALTY   = 40;   // staff specialty matches job service type
const W_PROXIMITY   = 35;   // staff is close to the job (Phase 2)
const W_CONTINUITY  = 25;   // staff has worked with this client before
const W_DAILY_LOAD  = 20;   // fewer jobs today  → higher score
const W_WEEKLY_LOAD = 15;   // fewer hours this week → higher score

/**
 * Distance beyond which proximity contributes nothing further to the
 * score — a staff member 60km away scores the same (0) as one 200km away;
 * both are "not close", and hard exclusion is left to the admin's judgment
 * rather than this heuristic. Tunable per-market if needed later.
 */
const PROXIMITY_MAX_KM = 40;

/**
 * Proximity score: 1.0 at 0km, linearly down to 0 at PROXIMITY_MAX_KM.
 * Returns null (no score, not zero) when either point lacks coordinates,
 * so callers can distinguish "far away" from "unknown".
 */
function proximityScore(
    distanceKm: number | null,
): { points: number; factor: number } | null {
    if (distanceKm === null) return null;
    const factor = Math.max(0, 1 - distanceKm / PROXIMITY_MAX_KM);
    return { points: Math.round(W_PROXIMITY * factor), factor };
}

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
    /** null when either the staff member or the job has no coordinates yet. */
    distanceKm:          number | null;
    estimatedTravelMins: number | null;
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
    address:         string;
    latitude:        number | null;
    longitude:       number | null;
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

    const jobLocation =
        isValidLatLng(job.latitude, job.longitude)
            ? { latitude: job.latitude as number, longitude: job.longitude as number }
            : null;

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

        // Proximity (Phase 2) — computed regardless of availability so the
        // UI can still show "12 min away" on a busy staff card, but only
        // contributes to `score` when the staff member is available.
        const staffLocation =
            isValidLatLng(staff.latitude, staff.longitude)
                ? { latitude: staff.latitude as number, longitude: staff.longitude as number }
                : null;
        const distanceKm =
            staffLocation && jobLocation
                ? Math.round(haversineDistanceKm(staffLocation, jobLocation) * 10) / 10
                : null;
        const estimatedTravelMins =
            distanceKm !== null ? estimateTravelMins(distanceKm) : null;

        if (!available) {
            score = -9999; // hard exclusion unless we allow override
        } else {
            // Specialty match
            const specialtyScore = specialtyMatchScore(staff.specialty, job.serviceType);
            if (specialtyScore > 0) {
                score += specialtyScore;
                reasons.push("Specialty match");
            }

            // Proximity / travel time (Phase 2)
            const proximity = proximityScore(distanceKm);
            if (proximity) {
                score += proximity.points;
                if (proximity.factor > 0.66) {
                    reasons.push("Nearby");
                } else if (proximity.factor > 0) {
                    reasons.push(`${estimatedTravelMins} min away`);
                }
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
            distanceKm,
            estimatedTravelMins,
            conflictingJobs: conflicts.map((j) => ({
                jobId:         j.id,
                jobRef:        j.jobRef,
                clientName:    j.client.name,
                scheduledDate: j.scheduledDate,
                durationMins:  j.durationMins,
            })),
        };
    });

    // Sort: highest score first, then nearest (unknown distance sorts last
    // within a score tier, not first — we don't want to imply "closest"
    // for staff we simply have no coordinates for), then alphabetically.
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.distanceKm !== b.distanceKm) {
            if (a.distanceKm === null) return 1;
            if (b.distanceKm === null) return -1;
            return a.distanceKm - b.distanceKm;
        }
        return a.name.localeCompare(b.name);
    });

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
        address:         job.address,
        latitude:        job.latitude,
        longitude:       job.longitude,
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

    const results: AutoDispatchResult[] = [];
    for (const { id } of unassignedJobs) {
        try {
            const result = await autoDispatch(id, user, options);
            results.push(result);
        } catch {
            // Log & skip failing individual job to prevent breaking the bulk run
            continue;
        }
    }
    return results;
};


export const jobDispatchService = {
    autoDispatch,
    bulkAutoDispatch,
};
