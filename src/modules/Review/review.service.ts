import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { FRONTEND_URL } from "../../config/ENV";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { IReviewFilters, IReviewLinkOptionsQuery, ISubmitPublicReview, IUpdateReview, ReviewShareLinkRequest } from "./review.interface";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { IRequestUser } from "../../types/requestUser.interface";
import { serviceDisplayName } from "../../lib/utils/serviceIdentity";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { invalidateBookingFormsForAdmin } from "../BookingForm/bookingForm.cache";
import { queueReviewRequestNotification } from "../../lib/notifications/businessNotificationEvents";
import { TenantPublicUrlService } from "../Website/tenantPublicUrl.service";
import { TenantAccessResolver } from "../Entitlement/tenantAccessResolver.service";

function deriveSentiment(rating: number): string {
    if (rating >= 4) return "positive";
    if (rating === 3) return "neutral";
    return "negative";
}

const REVIEW_TOKEN_TTL_DAYS = 7;

const nextReviewTokenExpiry = (now = new Date()) => {
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + REVIEW_TOKEN_TTL_DAYS);
    return expiresAt;
};

const configuredFrontendOrigin = (): string | null => {
    try {
        const parsed = new URL(FRONTEND_URL);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
        return parsed.origin;
    } catch {
        return null;
    }
};

const requireFrontendOrigin = (): string => {
    const origin = configuredFrontendOrigin();
    if (!origin) {
        throw new AppError(status.SERVICE_UNAVAILABLE, "Review links are temporarily unavailable.", {
            code: "REVIEW_FRONTEND_URL_UNAVAILABLE",
            retryable: false,
        });
    }
    return origin;
};

const buildJobReviewUrl = (token: string): string =>
    `${requireFrontendOrigin()}/review/${encodeURIComponent(token)}`;

/**
 * Returns one usable token per completed job. Expired unused tokens are rotated
 * atomically. Used tokens are terminal because a job may only be reviewed once.
 */
const generateReviewToken = async (jobId: string, adminId: string) =>
    prisma.$transaction(async (tx) => {
        await acquireExtendedTextTransactionAdvisoryLock(tx, `review-token-job:${jobId}`);

        let existing = await tx.reviewToken.findUnique({ where: { jobId } });
        if (existing) {
            if (existing.adminId !== adminId) {
                throw new AppError(status.NOT_FOUND, "Job not found.");
            }

            // Serialize with public submission, which locks using the token value.
            await acquireExtendedTextTransactionAdvisoryLock(tx, `review-token:${existing.token}`);
            existing = await tx.reviewToken.findUnique({ where: { jobId } });
            if (!existing || existing.adminId !== adminId) {
                throw new AppError(status.NOT_FOUND, "Job not found.");
            }
            if (existing.used) {
                throw new AppError(status.CONFLICT, "A review has already been submitted for this job.", {
                    code: "REVIEW_ALREADY_SUBMITTED",
                    retryable: false,
                });
            }
            if (existing.expiresAt.getTime() > Date.now()) return existing;

            return tx.reviewToken.update({
                where: { id: existing.id },
                data: {
                    token: randomUUID(),
                    used: false,
                    expiresAt: nextReviewTokenExpiry(),
                },
            });
        }

        return tx.reviewToken.create({
            data: {
                jobId,
                adminId,
                token: randomUUID(),
                expiresAt: nextReviewTokenExpiry(),
            },
        });
    });

const validateReviewToken = async (token: string) => {
    const reviewToken = await prisma.reviewToken.findUnique({
        where: { token },
        include: {
            job: {
                select: {
                    id: true,
                    adminId: true,
                    jobRef: true,
                    serviceType: true,
                    serviceNameSnapshot: true,
                    serviceCatalog: { select: { serviceName: true } },
                    scheduledDate: true,
                    client: { select: { name: true } },
                    staffAssignments: {
                        include: {
                            staff: { select: { id: true, user: { select: { name: true, image: true } } } },
                        },
                    },
                },
            },
        },
    });
    if (!reviewToken || reviewToken.adminId !== reviewToken.job.adminId) {
        // Treat corrupt/cross-tenant historical token data as an invalid public
        // link instead of leaking whether either tenant resource exists.
        throw new AppError(status.NOT_FOUND, "Invalid or expired review link.");
    }
    if (reviewToken.used) throw new AppError(status.GONE, "This review link has already been used.");
    if (new Date() > reviewToken.expiresAt) throw new AppError(status.GONE, "This review link has expired.");

    const { job } = reviewToken;
    return {
        tokenId: reviewToken.id,
        jobRef: job.jobRef,
        clientName: job.client.name,
        // Preserve serviceType for old clients and expose a canonical display value.
        serviceType: job.serviceType,
        serviceName: serviceDisplayName(job),
        completedDate: job.scheduledDate,
        assignedStaff: job.staffAssignments.map((a) => ({
            staffId: a.staff.id,
            staffName: a.staff.user.name,
            staffAvatar: a.staff.user.image ?? null,
        })),
        alreadySubmitted: false,
    };
};

const submitPublicReview = async (token: string, payload: ISubmitPublicReview) => {
    const tokenLockKey = `review-token:${token}`;
    return prisma.$transaction(async (tx) => {
        // Serialize all submissions for the same public token across instances.
        await acquireExtendedTextTransactionAdvisoryLock(tx, tokenLockKey);

        const reviewToken = await tx.reviewToken.findUnique({
            where: { token },
            include: {
                job: {
                    select: {
                        id: true,
                        adminId: true,
                        serviceCatalogId: true,
                        serviceNameSnapshot: true,
                        serviceCatalog: { select: { serviceName: true } },
                        client: { select: { name: true } },
                        staffAssignments: { select: { staffId: true } },
                    },
                },
            },
        });
        if (!reviewToken || reviewToken.adminId !== reviewToken.job.adminId) {
            throw new AppError(status.NOT_FOUND, "Invalid review link.");
        }
        if (reviewToken.used) throw new AppError(status.GONE, "Review already submitted.");
        if (new Date() > reviewToken.expiresAt) throw new AppError(status.GONE, "Review link expired.");

        const allowedStaffIds = new Set(reviewToken.job.staffAssignments.map((a) => a.staffId));
        const seenStaffIds = new Set<string>();
        for (const sr of payload.staffReviews) {
            if (!allowedStaffIds.has(sr.staffId) || seenStaffIds.has(sr.staffId)) {
                throw new AppError(status.UNPROCESSABLE_ENTITY, "Invalid staff review selection.", {
                    code: "INVALID_REVIEW_STAFF",
                    retryable: false,
                    fieldErrors: { staffReviews: "Only staff assigned to this job can be reviewed once." },
                });
            }
            seenStaffIds.add(sr.staffId);
        }

        const common = {
            reviewTokenId: reviewToken.id,
            jobId: reviewToken.job.id,
            adminId: reviewToken.adminId,
            source: "JOB_TOKEN" as const,
            serviceCatalogId: reviewToken.job.serviceCatalogId,
            serviceNameSnapshot: reviewToken.job.serviceNameSnapshot ?? reviewToken.job.serviceCatalog?.serviceName ?? null,
            clientName: reviewToken.job.client.name,
        };
        await tx.review.createMany({
            data: [
                {
                    ...common,
                    scope: "JOB" as const,
                    staffId: null,
                    rating: payload.serviceRating,
                    comment: payload.serviceComment ?? "",
                    sentiment: deriveSentiment(payload.serviceRating),
                },
                ...payload.staffReviews.map((sr) => ({
                    ...common,
                    scope: "STAFF" as const,
                    staffId: sr.staffId,
                    rating: sr.rating,
                    comment: sr.comment ?? "",
                    sentiment: deriveSentiment(sr.rating),
                })),
            ],
        });
        await tx.reviewToken.update({ where: { id: reviewToken.id }, data: { used: true } });
        return { success: true };
    });
};

type ReviewWebsiteLinkState = {
    available: boolean;
    state: "LIVE" | "NOT_PROVISIONED" | "UNPUBLISHED" | "PUBLIC_ACCESS_BLOCKED" | "ADDRESS_UNAVAILABLE";
    reason: string | null;
    code: string | null;
    websiteId: string | null;
    subdomain: string | null;
    canonicalOrigin: string | null;
    companyReviewUrl: string | null;
};

const getReviewWebsiteLinkState = async (adminId: string): Promise<ReviewWebsiteLinkState> => {
    const access = await TenantAccessResolver.resolve(adminId, { authoritative: true });

    if (!access.website.id || !access.website.subdomain) {
        return {
            available: false,
            state: "NOT_PROVISIONED",
            reason: "Create your business website before sharing website review links.",
            code: "REVIEW_WEBSITE_NOT_PROVISIONED",
            websiteId: null,
            subdomain: null,
            canonicalOrigin: null,
            companyReviewUrl: null,
        };
    }

    if (!access.website.published) {
        return {
            available: false,
            state: "UNPUBLISHED",
            reason: "Publish your business website before sharing company or service review links.",
            code: "REVIEW_WEBSITE_UNPUBLISHED",
            websiteId: access.website.id,
            subdomain: access.website.subdomain,
            canonicalOrigin: null,
            companyReviewUrl: null,
        };
    }

    if (!access.access.publicWebsiteAllowed) {
        return {
            available: false,
            state: "PUBLIC_ACCESS_BLOCKED",
            reason: "Your public website is not available with the current account or subscription state.",
            code: access.website.deniedReason,
            websiteId: access.website.id,
            subdomain: access.website.subdomain,
            canonicalOrigin: null,
            companyReviewUrl: null,
        };
    }

    try {
        const publicUrl = await TenantPublicUrlService.resolveForAdminId(adminId);
        const origin = publicUrl.origin.replace(/\/+$/, "");
        return {
            available: true,
            state: "LIVE",
            reason: null,
            code: null,
            websiteId: publicUrl.websiteId,
            subdomain: publicUrl.subdomain,
            canonicalOrigin: origin,
            companyReviewUrl: `${origin}/review`,
        };
    } catch (error) {
        if (error instanceof AppError) {
            return {
                available: false,
                state: "ADDRESS_UNAVAILABLE",
                reason: error.message,
                code: error.code ?? "WEBSITE_PUBLIC_ORIGIN_UNAVAILABLE",
                websiteId: access.website.id,
                subdomain: access.website.subdomain,
                canonicalOrigin: null,
                companyReviewUrl: null,
            };
        }
        throw error;
    }
};

const reviewTokenState = (token: { used: boolean; expiresAt: Date } | null) => {
    if (!token) return "NOT_CREATED" as const;
    if (token.used) return "SUBMITTED" as const;
    if (token.expiresAt.getTime() <= Date.now()) return "EXPIRED" as const;
    return "READY" as const;
};

const getReviewLinkOptions = async (query: IReviewLinkOptionsQuery, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const jobSearch = query.jobSearch?.trim();
    const jobLimit = Math.min(50, Math.max(1, Number(query.jobLimit) || 20));

    const [website, services, completedJobs] = await Promise.all([
        getReviewWebsiteLinkState(adminId),
        prisma.serviceCatalog.findMany({
            where: { adminId, status: "ACTIVE" },
            select: { id: true, serviceName: true, slug: true },
            orderBy: [{ serviceName: "asc" }, { id: "asc" }],
            take: 500,
        }),
        prisma.job.findMany({
            where: {
                adminId,
                status: "COMPLETED",
                ...(jobSearch
                    ? {
                        OR: [
                            { jobRef: { contains: jobSearch, mode: "insensitive" } },
                            { client: { name: { contains: jobSearch, mode: "insensitive" } } },
                            { serviceNameSnapshot: { contains: jobSearch, mode: "insensitive" } },
                        ],
                    }
                    : {}),
            },
            select: {
                id: true,
                jobRef: true,
                scheduledDate: true,
                updatedAt: true,
                serviceType: true,
                serviceNameSnapshot: true,
                serviceCatalog: { select: { serviceName: true } },
                client: { select: { name: true } },
                reviewToken: { select: { token: true, used: true, expiresAt: true } },
            },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: jobLimit,
        }),
    ]);

    const appOrigin = configuredFrontendOrigin();
    return {
        website,
        services: services.map((service) => ({
            id: service.id,
            name: service.serviceName,
            slug: service.slug,
            reviewUrl: website.available && website.canonicalOrigin
                ? `${website.canonicalOrigin}/${encodeURIComponent(service.slug)}/review`
                : null,
        })),
        completedJobs: completedJobs.map((job) => {
            const tokenState = reviewTokenState(job.reviewToken);
            return {
                id: job.id,
                jobRef: job.jobRef,
                clientName: job.client.name,
                serviceName: serviceDisplayName(job),
                scheduledDate: job.scheduledDate,
                completedAt: job.updatedAt,
                tokenState,
                tokenExpiresAt: job.reviewToken?.expiresAt ?? null,
                reviewUrl:
                    tokenState === "READY" && appOrigin && job.reviewToken
                        ? `${appOrigin}/review/${encodeURIComponent(job.reviewToken.token)}`
                        : null,
                canCreateLink: tokenState !== "SUBMITTED",
            };
        }),
    };
};

const assertWebsiteShareLinkReady = (website: ReviewWebsiteLinkState) => {
    if (website.available && website.canonicalOrigin) return website.canonicalOrigin;
    const httpStatus = website.state === "ADDRESS_UNAVAILABLE"
        ? status.SERVICE_UNAVAILABLE
        : status.CONFLICT;
    throw new AppError(httpStatus, website.reason ?? "Website review link is not available.", {
        code: website.code ?? "REVIEW_WEBSITE_LINK_UNAVAILABLE",
        retryable: website.state === "ADDRESS_UNAVAILABLE",
    });
};

const createReviewShareLink = async (payload: ReviewShareLinkRequest, user: IRequestUser) => {
    const adminId = await getAdminId(user);

    if (payload.kind === "COMPANY") {
        const website = await getReviewWebsiteLinkState(adminId);
        const origin = assertWebsiteShareLinkReady(website);
        return {
            kind: payload.kind,
            url: `${origin}/review`,
            expiresAt: null,
            website: { id: website.websiteId!, subdomain: website.subdomain!, canonicalOrigin: origin },
        };
    }

    if (payload.kind === "SERVICE") {
        const [website, service] = await Promise.all([
            getReviewWebsiteLinkState(adminId),
            prisma.serviceCatalog.findFirst({
                where: { id: payload.serviceCatalogId, adminId, status: "ACTIVE" },
                select: { id: true, serviceName: true, slug: true },
            }),
        ]);
        if (!service) {
            throw new AppError(status.NOT_FOUND, "Active service not found.", {
                code: "REVIEW_SERVICE_NOT_FOUND",
                retryable: false,
            });
        }
        const origin = assertWebsiteShareLinkReady(website);
        return {
            kind: payload.kind,
            url: `${origin}/${encodeURIComponent(service.slug)}/review`,
            expiresAt: null,
            service: { id: service.id, name: service.serviceName, slug: service.slug },
            website: { id: website.websiteId!, subdomain: website.subdomain!, canonicalOrigin: origin },
        };
    }

    const job = await prisma.job.findFirst({
        where: { id: payload.jobId, adminId },
        select: {
            id: true,
            jobRef: true,
            status: true,
            serviceType: true,
            serviceNameSnapshot: true,
            serviceCatalog: { select: { serviceName: true } },
            client: { select: { name: true } },
        },
    });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found.");
    if (job.status !== "COMPLETED") {
        throw new AppError(status.CONFLICT, "Only completed jobs can receive a review link.", {
            code: "REVIEW_JOB_NOT_COMPLETED",
            retryable: false,
        });
    }

    const token = await generateReviewToken(job.id, adminId);
    return {
        kind: payload.kind,
        url: buildJobReviewUrl(token.token),
        expiresAt: token.expiresAt,
        job: {
            id: job.id,
            jobRef: job.jobRef,
            clientName: job.client.name,
            serviceName: serviceDisplayName(job),
        },
    };
};

const getAllReviews = async (filters: IReviewFilters, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const {
        page = 1, limit = 10, searchTerm, status: filterStatus, rating,
        staffId, jobId, dateFrom, dateTo, scope, source, serviceCatalogId,
    } = filters;

    const tenantRelationGuard = {
        OR: [
            { source: "JOB_TOKEN", reviewToken: { job: { adminId } } },
            { source: "WEBSITE", website: { adminId } },
        ],
    };
    const and: any[] = [tenantRelationGuard];
    const where: any = { adminId, AND: and };
    if (filterStatus) where.status = filterStatus;
    if (rating) where.rating = Number(rating);
    if (scope) where.scope = scope;
    if (source) where.source = source;
    if (serviceCatalogId) where.serviceCatalogId = serviceCatalogId;
    if (staffId === "not-null") where.NOT = { staffId: null };
    else if (staffId) where.staffId = staffId;
    if (jobId) where.jobId = jobId;
    if (searchTerm) {
        and.push({
            OR: [
                { clientName: { contains: searchTerm, mode: "insensitive" } },
                { comment: { contains: searchTerm, mode: "insensitive" } },
                { serviceNameSnapshot: { contains: searchTerm, mode: "insensitive" } },
            ],
        });
    }
    if (dateFrom || dateTo) {
        where.createdAt = {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : {}),
        };
    }

    const include = {
        reviewToken: {
            include: {
                job: {
                    select: {
                        jobRef: true,
                        serviceType: true,
                        serviceNameSnapshot: true,
                        serviceCatalog: { select: { serviceName: true, slug: true } },
                    },
                },
            },
        },
        serviceCatalog: { select: { id: true, serviceName: true, slug: true } },
        website: { select: { id: true, subdomain: true } },
        websiteContact: { select: { email: true, phone: true } },
    } as const;

    const statsWhere: any = { adminId, AND: [tenantRelationGuard] };
    const [total, reviews, allForAdmin] = await Promise.all([
        prisma.review.count({ where }),
        prisma.review.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (Number(page) - 1) * Number(limit),
            take: Number(limit),
            include,
        }),
        prisma.review.findMany({
            where: statsWhere,
            select: { rating: true, status: true, comment: true },
        }),
    ]);

    const published = allForAdmin.filter((r) => r.status === "published");
    const avgRating = published.length > 0
        ? Math.round((published.reduce((sum, review) => sum + review.rating, 0) / published.length) * 10) / 10
        : 0;
    return {
        data: reviews,
        meta: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) },
        stats: {
            total: allForAdmin.length,
            submitted: published.length,
            pending: allForAdmin.filter((review) => review.status === "pending").length,
            flagged: allForAdmin.filter((review) => review.status === "flagged").length,
            averageRating: avgRating,
            responseRate: allForAdmin.length > 0
                ? Math.round((allForAdmin.filter((review) => Boolean(review.comment)).length / allForAdmin.length) * 100)
                : 0,
        },
    };
};

const getReviewById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const review = await prisma.review.findFirst({
        where: {
            id,
            adminId,
            OR: [
                { source: "JOB_TOKEN", reviewToken: { job: { adminId } } },
                { source: "WEBSITE", website: { adminId } },
            ],
        },
        include: {
            reviewToken: {
                include: {
                    job: {
                        select: {
                            jobRef: true,
                            serviceType: true,
                            serviceNameSnapshot: true,
                            serviceCatalog: { select: { serviceName: true, slug: true } },
                        },
                    },
                },
            },
            serviceCatalog: { select: { id: true, serviceName: true, slug: true } },
            website: { select: { id: true, subdomain: true } },
            websiteContact: { select: { email: true, phone: true } },
        },
    });
    if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");
    return review;
};

const updateReview = async (id: string, payload: IUpdateReview, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const review = await prisma.review.findFirst({ where: { id, adminId }, select: { id: true } });
    if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");
    const canonicalStatus =
        payload.status ??
        (payload.isPublished === undefined
            ? undefined
            : payload.isPublished
              ? "published"
              : "unpublished");
    const updated = await prisma.review.update({
        where: { id },
        data: {
            ...(canonicalStatus !== undefined
                ? { status: canonicalStatus, isPublished: canonicalStatus === "published" }
                : {}),
            ...(payload.adminReply !== undefined ? { adminReply: payload.adminReply } : {}),
        },
    });
    await Promise.all([
        WebsiteProjectionCacheService.invalidateAdminWebsite(adminId),
        invalidateBookingFormsForAdmin(adminId),
    ]);
    return updated;
};

const getStaffReviewSummaries = async (user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const staffReviews = await prisma.review.findMany({
        where: { adminId, source: "JOB_TOKEN", scope: "STAFF", NOT: { staffId: null }, reviewToken: { job: { adminId } } },
        include: {
            reviewToken: {
                include: {
                    job: {
                        include: {
                            staffAssignments: {
                                include: { staff: { include: { user: { select: { name: true } } } } },
                            },
                        },
                    },
                },
            },
        },
    });

    const map = new Map<string, {
        staffName: string; total: number; sum: number; ratingCounts: number[];
        comments: { comment: string; clientName: string; date: Date }[];
    }>();
    for (const review of staffReviews) {
        const sid = review.staffId!;
        if (!map.has(sid)) {
            const assignment = review.reviewToken?.job.staffAssignments.find((a) => a.staffId === sid);
            map.set(sid, {
                staffName: assignment?.staff.user.name ?? "Unknown Staff",
                total: 0, sum: 0, ratingCounts: [0, 0, 0, 0, 0], comments: [],
            });
        }
        const entry = map.get(sid)!;
        entry.total++;
        entry.sum += review.rating;
        if (review.rating >= 1 && review.rating <= 5) entry.ratingCounts[review.rating - 1]++;
        if (review.comment) entry.comments.push({ comment: review.comment, clientName: review.clientName, date: review.createdAt });
    }
    return {
        summaries: Array.from(map.entries()).map(([staffId, data]) => ({
            staffId,
            staffName: data.staffName,
            totalReviews: data.total,
            averageRating: data.total > 0 ? Math.round((data.sum / data.total) * 10) / 10 : 0,
            ratings: [5, 4, 3, 2, 1].map((star) => ({ star, count: data.ratingCounts[star - 1] })),
            recentComments: data.comments.slice(-3).reverse(),
        })),
    };
};

const generateTokenForJob = async (jobId: string, user: IRequestUser, occurrence = "initial") => {
    const adminId = await getAdminId(user);
    const job = await prisma.job.findFirst({
        where: { id: jobId, adminId },
        select: {
            id: true, adminId: true, status: true, jobRef: true,
            serviceType: true, serviceNameSnapshot: true,
            serviceCatalog: { select: { serviceName: true } },
            scheduledDate: true, clientId: true,
            staffAssignments: { include: { staff: { include: { user: { select: { name: true } } } } } },
        },
    });
    if (!job) throw new AppError(status.NOT_FOUND, "Job not found.");
    if (job.status !== "COMPLETED") throw new AppError(status.BAD_REQUEST, "Job must be COMPLETED to generate a review token.");

    const token = await generateReviewToken(jobId, adminId);
    const reviewUrl = buildJobReviewUrl(token.token);
    await queueReviewRequestNotification(
        job.id,
        reviewUrl,
        occurrence,
    );
    return { ...token, reviewUrl };
};

const resendReviewEmail = async (reviewId: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const review = await prisma.review.findFirst({
        where: { id: reviewId, adminId },
        select: { jobId: true, source: true },
    });
    if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");
    if (review.source !== "JOB_TOKEN" || !review.jobId) {
        throw new AppError(status.BAD_REQUEST, "Website reviews do not have a review-request email to resend.", {
            code: "REVIEW_RESEND_NOT_AVAILABLE",
            retryable: false,
        });
    }
    return generateTokenForJob(review.jobId, user, `resend:${reviewId}:${Date.now()}`);
};

export const reviewService = {
    generateReviewToken,
    validateReviewToken,
    submitPublicReview,
    getReviewLinkOptions,
    createReviewShareLink,
    getAllReviews,
    getReviewById,
    updateReview,
    getStaffReviewSummaries,
    generateTokenForJob,
    resendReviewEmail,
};
