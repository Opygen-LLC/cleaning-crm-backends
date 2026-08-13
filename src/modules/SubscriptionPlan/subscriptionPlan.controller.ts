import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { subscriptionPlanService } from "./subscriptionPlan.service";

const getAllSubscriptionPlans = catchAsync(async (req, res) => {
    const result = await subscriptionPlanService.getAllSubscriptionPlans();

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription plans retrieved successfully",
        data: result,
    });
});

const getSubscriptionPlanById = catchAsync(async (req, res) => {
    const result = await subscriptionPlanService.getSubscriptionPlanById(
        req.params.id as string,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Subscription plan retrieved successfully",
        data: result,
    });
});

export const subscriptionPlanController = {
    getAllSubscriptionPlans,
    getSubscriptionPlanById,
};
