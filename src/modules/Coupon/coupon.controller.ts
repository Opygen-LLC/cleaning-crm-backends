import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { couponService } from "./coupon.service";

const createCoupon = catchAsync(async (req, res) => {
    const result = await couponService.createCoupon(req.body);
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Coupon created successfully",
        data: result,
    });
});

const getAllCoupons = catchAsync(async (req, res) => {
    const filters = {
        searchTerm: req.query.searchTerm as string | undefined,
        discountType: req.query.discountType as any,
        isActive:
            req.query.isActive !== undefined
                ? req.query.isActive === "true"
                : undefined,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 10,
    };
    const result = await couponService.getAllCoupons(filters);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Coupons retrieved successfully",
        data: result,
    });
});

const getCouponStats = catchAsync(async (req, res) => {
    const result = await couponService.getCouponStats();
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Coupon stats retrieved successfully",
        data: result,
    });
});

const getCouponById = catchAsync(async (req, res) => {
    const result = await couponService.getCouponById(req.params.id as string);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Coupon retrieved successfully",
        data: result,
    });
});

const updateCoupon = catchAsync(async (req, res) => {
    const result = await couponService.updateCoupon(
        req.params.id as string,
        req.body,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Coupon updated successfully",
        data: result,
    });
});

const toggleCoupon = catchAsync(async (req, res) => {
    const result = await couponService.toggleCoupon(req.params.id as string);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Coupon ${result.isActive ? "activated" : "deactivated"} successfully`,
        data: result,
    });
});

const deleteCoupon = catchAsync(async (req, res) => {
    await couponService.deleteCoupon(req.params.id as string);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Coupon deleted successfully",
        data: null,
    });
});

const validateCoupon = catchAsync(async (req, res) => {
    const result = await couponService.validateCoupon(req.body.code);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Coupon is valid",
        data: result,
    });
});

export const couponController = {
    createCoupon,
    getAllCoupons,
    getCouponStats,
    getCouponById,
    updateCoupon,
    toggleCoupon,
    deleteCoupon,
    validateCoupon,
};
