import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { pricingRulesService } from "./pricingRules.service";

const getPricingRules = catchAsync(async (req, res) => {
    const result = await pricingRulesService.getPricingRules(req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Pricing rules retrieved successfully",
        data: result,
    });
});

const upsertPricingRules = catchAsync(async (req, res) => {
    const result = await pricingRulesService.upsertPricingRules(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Pricing rules saved successfully",
        data: result,
    });
});

export const pricingRulesController = {
    getPricingRules,
    upsertPricingRules,
};
