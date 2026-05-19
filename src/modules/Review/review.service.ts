import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { IReviewFilters, ISubmitPublicReview, IUpdateReview } from "./review.interface";

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveSentiment(rating: number): string {
  if (rating >= 4) return "positive";
  if (rating === 3) return "neutral";
  return "negative";
}

// ── Token generation (called when a Job is marked COMPLETED) ─────────────────

const generateReviewToken = async (jobId: string, adminId: string) => {
  const existing = await prisma.reviewToken.findUnique({ where: { jobId } });
  if (existing) return existing;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  return prisma.reviewToken.create({
    data: { jobId, adminId, expiresAt },
  });
};

// ── Public: validate token ────────────────────────────────────────────────────

const validateReviewToken = async (token: string) => {
  const reviewToken = await prisma.reviewToken.findUnique({
    where: { token },
    include: {
      job: {
        select: {
          id: true,
          jobRef: true,
          serviceType: true,
          scheduledDate: true,
          client: { select: { name: true } },
          staffAssignments: {
            include: {
              staff: {
                select: {
                  id: true,
                  user: { select: { name: true, image: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!reviewToken) throw new AppError(status.NOT_FOUND, "Invalid or expired review link.");
  if (reviewToken.used) throw new AppError(status.GONE, "This review link has already been used.");
  if (new Date() > reviewToken.expiresAt) throw new AppError(status.GONE, "This review link has expired.");

  const { job } = reviewToken;

  return {
    tokenId: reviewToken.id,
    jobRef: job.jobRef,
    clientName: job.client.name,
    serviceType: job.serviceType,
    completedDate: job.scheduledDate,
    assignedStaff: job.staffAssignments.map((a: any) => ({
      staffId: a.staff.id,
      staffName: a.staff.user.name,
      staffAvatar: a.staff.user.image ?? null,
    })),
    alreadySubmitted: reviewToken.used,
  };
};

// ── Public: submit review ─────────────────────────────────────────────────────

const submitPublicReview = async (token: string, payload: ISubmitPublicReview) => {
  const reviewToken = await prisma.reviewToken.findUnique({
    where: { token },
    include: {
      job: {
        select: {
          id: true,
          adminId: true,
          client: { select: { name: true } },
        },
      },
    },
  });

  if (!reviewToken) throw new AppError(status.NOT_FOUND, "Invalid review link.");
  if (reviewToken.used) throw new AppError(status.GONE, "Review already submitted.");
  if (new Date() > reviewToken.expiresAt) throw new AppError(status.GONE, "Review link expired.");

  const clientName = reviewToken.job.client.name;
  const adminId = reviewToken.job.adminId;
  const jobId = reviewToken.job.id;

  const reviewData = [
    // Overall service review (staffId = null)
    {
      reviewTokenId: reviewToken.id,
      jobId,
      adminId,
      staffId: null as string | null,
      clientName,
      rating: payload.serviceRating,
      comment: payload.serviceComment ?? "",
      sentiment: deriveSentiment(payload.serviceRating),
    },
    // Per-staff reviews
    ...payload.staffReviews.map((sr) => ({
      reviewTokenId: reviewToken.id,
      jobId,
      adminId,
      staffId: sr.staffId as string | null,
      clientName,
      rating: sr.rating,
      comment: sr.comment ?? "",
      sentiment: deriveSentiment(sr.rating),
    })),
  ];

  await prisma.$transaction([
    prisma.review.createMany({ data: reviewData }),
    prisma.reviewToken.update({ where: { id: reviewToken.id }, data: { used: true } }),
  ]);

  return { success: true };
};

// ── Admin: list reviews ───────────────────────────────────────────────────────

const getAllReviews = async (filters: IReviewFilters, user: any) => {
  const { page = 1, limit = 10, searchTerm, status: filterStatus, rating, staffId } = filters;

  let adminId: string | undefined;
  if (user.role === "ADMIN") {
    const profile = await prisma.adminProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    adminId = profile?.id;
  }

  const where: any = {};
  if (adminId) where.adminId = adminId;
  if (filterStatus) where.status = filterStatus;
  if (rating) where.rating = Number(rating);
  if (staffId) where.staffId = staffId;
  if (searchTerm) {
    where.OR = [
      { clientName: { contains: searchTerm, mode: "insensitive" } },
      { comment: { contains: searchTerm, mode: "insensitive" } },
    ];
  }

  const total = await prisma.review.count({ where });
  const reviews = await prisma.review.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (Number(page) - 1) * Number(limit),
    take: Number(limit),
    include: {
      reviewToken: {
        include: {
          job: { select: { jobRef: true, serviceType: true } },
        },
      },
    },
  });

  const allForAdmin = await prisma.review.findMany({
    where: adminId ? { adminId } : {},
    select: { rating: true, status: true, comment: true },
  });

  const published = allForAdmin.filter((r) => r.status === "published");
  const avgRating =
    published.length > 0
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
      responseRate:
        allForAdmin.length > 0
          ? Math.round((allForAdmin.filter((r) => !!r.comment).length / allForAdmin.length) * 100)
          : 0,
    },
  };
};

// ── Admin: get review by id ───────────────────────────────────────────────────

const getReviewById = async (id: string, _user: any) => {
  const review = await prisma.review.findUnique({
    where: { id },
    include: {
      reviewToken: { include: { job: { select: { jobRef: true, serviceType: true } } } },
    },
  });
  if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");
  return review;
};

// ── Admin: update review ──────────────────────────────────────────────────────

const updateReview = async (id: string, payload: IUpdateReview) => {
  const review = await prisma.review.findUnique({ where: { id } });
  if (!review) throw new AppError(status.NOT_FOUND, "Review not found.");

  return prisma.review.update({
    where: { id },
    data: {
      ...(payload.status !== undefined
        ? { status: payload.status, isPublished: payload.status === "published" }
        : {}),
      ...(payload.isPublished !== undefined
        ? { isPublished: payload.isPublished, status: payload.isPublished ? "published" : "unpublished" }
        : {}),
      ...(payload.adminReply !== undefined ? { adminReply: payload.adminReply } : {}),
    },
  });
};

// ── Admin: staff review summaries ─────────────────────────────────────────────

const getStaffReviewSummaries = async (user: any) => {
  let adminId: string | undefined;
  if (user.role === "ADMIN") {
    const profile = await prisma.adminProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    adminId = profile?.id;
  }

  const staffReviews = await prisma.review.findMany({
    where: {
      ...(adminId ? { adminId } : {}),
      NOT: { staffId: null },
    },
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
    staffName: string;
    total: number;
    sum: number;
    ratingCounts: number[];
    comments: { comment: string; clientName: string; date: Date }[];
  }>();

  for (const review of staffReviews) {
    const sid = review.staffId!;
    if (!map.has(sid)) {
      const assignment = review.reviewToken.job.staffAssignments.find(
        (a: any) => a.staffId === sid
      );
      const staffName = assignment?.staff.user.name ?? "Unknown Staff";
      map.set(sid, { staffName, total: 0, sum: 0, ratingCounts: [0, 0, 0, 0, 0], comments: [] });
    }
    const entry = map.get(sid)!;
    entry.total++;
    entry.sum += review.rating;
    if (review.rating >= 1 && review.rating <= 5) entry.ratingCounts[review.rating - 1]++;
    if (review.comment) {
      entry.comments.push({ comment: review.comment, clientName: review.clientName, date: review.createdAt });
    }
  }

  const summaries = Array.from(map.entries()).map(([staffId, data]) => ({
    staffId,
    staffName: data.staffName,
    totalReviews: data.total,
    averageRating: data.total > 0 ? Math.round((data.sum / data.total) * 10) / 10 : 0,
    ratings: [5, 4, 3, 2, 1].map((star) => ({ star, count: data.ratingCounts[star - 1] })),
    recentComments: data.comments.slice(-3).reverse(),
  }));

  return { summaries };
};

// ── Admin: manually generate token for a completed job ───────────────────────

const generateTokenForJob = async (jobId: string, _user: any) => {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, adminId: true, status: true },
  });
  if (!job) throw new AppError(status.NOT_FOUND, "Job not found.");
  if (job.status !== "COMPLETED") {
    throw new AppError(status.BAD_REQUEST, "Job must be COMPLETED to generate a review token.");
  }
  return generateReviewToken(jobId, job.adminId);
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
};
