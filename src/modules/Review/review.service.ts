import { prisma } from "../../lib/prisma/prisma";
import { acquireExtendedTextTransactionAdvisoryLock } from "../../lib/prisma/advisoryLock";
import { sendEmailSafely } from "../../lib/utils/sendEmailSafely";
import { FRONTEND_URL } from "../../config/ENV";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { IReviewFilters, ISubmitPublicReview, IUpdateReview } from "./review.interface";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { IRequestUser } from "../../types/requestUser.interface";
import { serviceDisplayName } from "../../lib/utils/serviceIdentity";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { invalidateBookingFormsForAdmin } from "../BookingForm/bookingForm.cache";

function deriveSentiment(rating: number): string {
    if (rating >= 4) return "positive";
    if (rating === 3) return "neutral";
    return "negative";
}

const generateReviewToken = async (jobId: string, adminId: string) => {
    const existing = await prisma.reviewToken.findUnique({ where: { jobId } });
    if (existing) {
        if (existing.adminId !== adminId) {
            throw new AppError(status.NOT_FOUND, "Job not found.");
        }
        return existing;
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    return prisma.reviewToken.create({ data: { jobId, adminId, expiresAt } });
};

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
            clientName: reviewToken.job.client.name,
        };
        await tx.review.createMany({
            data: [
                {
                    ...common,
                    staffId: null,
                    rating: payload.serviceRating,
                    comment: payload.serviceComment ?? "",
                    sentiment: deriveSentiment(payload.serviceRating),
                },
                ...payload.staffReviews.map((sr) => ({
                    ...common,
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

const getAllReviews = async (filters: IReviewFilters, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const {
        page = 1, limit = 10, searchTerm, status: filterStatus, rating,
        staffId, jobId, dateFrom, dateTo,
    } = filters;
    const where: any = {
        adminId,
        // A Review row and the job behind its capability token must agree on
        // tenant ownership. This prevents corrupt historical relations from
        // pulling another tenant's job/service data into an admin list.
        reviewToken: { job: { adminId } },
    };
    if (filterStatus) where.status = filterStatus;
    if (rating) where.rating = Number(rating);
    if (staffId) where.staffId = staffId;
    if (jobId) where.jobId = jobId;
    if (searchTerm) {
        where.OR = [
            { clientName: { contains: searchTerm, mode: "insensitive" } },
            { comment: { contains: searchTerm, mode: "insensitive" } },
        ];
    }
    if (dateFrom || dateTo) {
        where.createdAt = {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : {}),
        };
    }

    const [total, reviews, allForAdmin] = await Promise.all([
        prisma.review.count({ where }),
        prisma.review.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (Number(page) - 1) * Number(limit),
            take: Number(limit),
            include: {
                reviewToken: {
                    include: {
                        job: {
                            select: {
                                jobRef: true,
                                serviceType: true,
                                serviceNameSnapshot: true,
                                serviceCatalog: { select: { serviceName: true } },
                            },
                        },
                    },
                },
            },
        }),
        prisma.review.findMany({
            where: { adminId, reviewToken: { job: { adminId } } },
            select: { rating: true, status: true, comment: true },
        }),
    ]);

    const published = allForAdmin.filter((r) => r.status === "published");
    const avgRating = published.length > 0
        ? Math.round((published.reduce((s, r) => s + r.rating, 0) / published.length) * 10) / 10
        : 0;
    return {
        data: reviews,
        meta: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) },
        stats: {
            total: allForAdmin.length,
            submitted: published.length,
            pending: allForAdmin.filter((r) => r.status === "pending").length,
            flagged: allForAdmin.filter((r) => r.status === "flagged").length,
            averageRating: avgRating,
            responseRate: allForAdmin.length > 0
                ? Math.round((allForAdmin.filter((r) => !!r.comment).length / allForAdmin.length) * 100)
                : 0,
        },
    };
};

const getReviewById = async (id: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const review = await prisma.review.findFirst({
        where: { id, adminId, reviewToken: { job: { adminId } } },
        include: {
            reviewToken: {
                include: {
                    job: {
                        select: {
                            jobRef: true,
                            serviceType: true,
                            serviceNameSnapshot: true,
                            serviceCatalog: { select: { serviceName: true } },
                        },
                    },
                },
            },
        },
    });
    if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");
    return review;
};

const updateReview = async (id: string, payload: IUpdateReview, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const review = await prisma.review.findFirst({ where: { id, adminId }, select: { id: true } });
    if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");
    const updated = await prisma.review.update({
        where: { id },
        data: {
            ...(payload.status !== undefined ? { status: payload.status, isPublished: payload.status === "published" } : {}),
            ...(payload.isPublished !== undefined
                ? { isPublished: payload.isPublished, status: payload.isPublished ? "published" : "unpublished" }
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
        where: { adminId, NOT: { staffId: null }, reviewToken: { job: { adminId } } },
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
            const assignment = review.reviewToken.job.staffAssignments.find((a) => a.staffId === sid);
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

const generateTokenForJob = async (jobId: string, user: IRequestUser) => {
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
    const client = await prisma.client.findFirst({
        where: { id: job.clientId, adminId },
        select: { name: true, email: true },
    });
    if (client) {
        await sendEmailSafely({
            adminId,
            to: client.email,
            subject: `How did we do? — ${job.jobRef}`,
            templateName: "review-request",
            templateData: {
                clientName: client.name,
                jobRef: job.jobRef,
                serviceType: serviceDisplayName(job),
                completedDate: new Date(job.scheduledDate).toLocaleDateString("en-GB", {
                    weekday: "long", day: "numeric", month: "long", year: "numeric",
                }),
                staffNames: job.staffAssignments.map((a) => a.staff.user.name),
                reviewUrl: `${FRONTEND_URL}/review/${token.token}`,
            },
        });
    }
    return token;
};

const resendReviewEmail = async (reviewId: string, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const review = await prisma.review.findFirst({ where: { id: reviewId, adminId }, select: { jobId: true } });
    if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");
    return generateTokenForJob(review.jobId, user);
};

export const reviewService = {
    generateReviewToken,
    validateReviewToken,
    submitPublicReview,
    getAllReviews,
    getReviewById,
    updateReview,
    getStaffReviewSummaries,
    generateTokenForJob,
    resendReviewEmail,
};
