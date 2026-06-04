import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { ICouponCreate, ICouponUpdate, ICouponFilters } from "./coupon.interface";
import { IRequestUser } from "../../types/requestUser.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPagination(page?: number, limit?: number) {
    const p = Number(page) || 1;
    const l = Number(limit) || 10;
    return { page: p, limit: l, skip: (p - 1) * l };
}

// ─── Create ───────────────────────────────────────────────────────────────────

const createCoupon = async (payload: ICouponCreate) => {
    const existing = await prisma.coupon.findUnique({ where: { code: payload.code } });
    if (existing) throw new AppError(status.CONFLICT, "A coupon with this code already exists");

    return prisma.coupon.create({
        data: {
            code:          payload.code.toUpperCase().trim(),
            description:   payload.description,
            discountType:  payload.discountType,
            discountValue: payload.discountValue,
            maxUses:       payload.maxUses ?? null,
            validFrom:     payload.validFrom ? new Date(payload.validFrom) : null,
            validUntil:    payload.validUntil ? new Date(payload.validUntil) : null,
            isActive:      payload.isActive ?? true,
        },
    });
};

// ─── Read all ─────────────────────────────────────────────────────────────────

const getAllCoupons = async (filters: ICouponFilters) => {
    const { page, limit, skip } = buildPagination(filters.page, filters.limit);
    const { searchTerm, isActive, discountType } = filters;

    const andConditions: object[] = [];

    if (searchTerm) {
        andConditions.push({
            OR: [
                { code:        { contains: searchTerm, mode: "insensitive" } },
                { description: { contains: searchTerm, mode: "insensitive" } },
            ],
        });
    }

    if (isActive !== undefined) andConditions.push({ isActive });
    if (discountType)           andConditions.push({ discountType });

    const where = andConditions.length ? { AND: andConditions } : {};

    const [total, coupons] = await Promise.all([
        prisma.coupon.count({ where }),
        prisma.coupon.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: "desc" },
            include: { _count: { select: { couponUsage: true } } },
        }),
    ]);

    return {
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        data: coupons,
    };
};

// ─── Read one ─────────────────────────────────────────────────────────────────

const getCouponById = async (id: string) => {
    const coupon = await prisma.coupon.findUnique({
        where: { id },
        include: {
            couponUsage: {
                take: 20,
                orderBy: { usedAt: "desc" },
                include: {
                    admin: { select: { id: true, businessName: true } },
                },
            },
        },
    });
    if (!coupon) throw new AppError(status.NOT_FOUND, "Coupon not found");
    return coupon;
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateCoupon = async (id: string, payload: ICouponUpdate) => {
    await getCouponById(id); // 404 guard

    if (payload.code) {
        const conflict = await prisma.coupon.findFirst({
            where: { code: payload.code.toUpperCase().trim(), NOT: { id } },
        });
        if (conflict) throw new AppError(status.CONFLICT, "Coupon code already in use");
    }

    return prisma.coupon.update({
        where: { id },
        data: {
            ...(payload.code        && { code:        payload.code.toUpperCase().trim() }),
            ...(payload.description !== undefined && { description: payload.description }),
            ...(payload.discountType  && { discountType:  payload.discountType }),
            ...(payload.discountValue !== undefined && { discountValue: payload.discountValue }),
            ...(payload.maxUses       !== undefined && { maxUses:       payload.maxUses }),
            ...(payload.validFrom     !== undefined && { validFrom:     payload.validFrom ? new Date(payload.validFrom) : null }),
            ...(payload.validUntil    !== undefined && { validUntil:    payload.validUntil ? new Date(payload.validUntil) : null }),
            ...(payload.isActive      !== undefined && { isActive:      payload.isActive }),
        },
    });
};

// ─── Toggle active ────────────────────────────────────────────────────────────

const toggleCoupon = async (id: string) => {
    const coupon = await getCouponById(id);
    return prisma.coupon.update({ where: { id }, data: { isActive: !coupon.isActive } });
};

// ─── Delete ───────────────────────────────────────────────────────────────────

const deleteCoupon = async (id: string) => {
    await getCouponById(id);
    const usageCount = await prisma.couponUsage.count({ where: { couponId: id } });
    if (usageCount > 0) {
        throw new AppError(
            status.CONFLICT,
            `Cannot delete a coupon that has been used ${usageCount} time(s). Deactivate it instead.`,
        );
    }
    return prisma.coupon.delete({ where: { id } });
};

// ─── Stats ────────────────────────────────────────────────────────────────────

const getCouponStats = async () => {
    const [total, active, totalUsage] = await Promise.all([
        prisma.coupon.count(),
        prisma.coupon.count({ where: { isActive: true } }),
        prisma.couponUsage.count(),
    ]);

    const topCoupons = await prisma.coupon.findMany({
        take: 5,
        orderBy: { usedCount: "desc" },
        select: { id: true, code: true, usedCount: true, discountType: true, discountValue: true },
    });

    return { total, active, inactive: total - active, totalUsage, topCoupons };
};

// ─── Validate (public — used during subscription checkout) ────────────────────

const validateCoupon = async (code: string) => {
    const coupon = await prisma.coupon.findFirst({
        where: {
            code:     code.toUpperCase().trim(),
            isActive: true,
            OR: [
                { validUntil: null },
                { validUntil: { gte: new Date() } },
            ],
        },
    });

    if (!coupon) throw new AppError(status.NOT_FOUND, "Invalid or expired coupon code");

    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
        throw new AppError(status.GONE, "This coupon has reached its maximum usage limit");
    }

    return {
        id:            coupon.id,
        code:          coupon.code,
        description:   coupon.description,
        discountType:  coupon.discountType,
        discountValue: coupon.discountValue,
        validUntil:    coupon.validUntil,
    };
};

export const couponService = {
    createCoupon,
    getAllCoupons,
    getCouponById,
    updateCoupon,
    toggleCoupon,
    deleteCoupon,
    getCouponStats,
    validateCoupon,
};
