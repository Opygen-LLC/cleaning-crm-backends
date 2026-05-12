import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { paymentGatewayService } from "./paymentGateway.service";

const getConfig = catchAsync(async (req, res) => {
    const result = await paymentGatewayService.getPaymentGatewayConfig(
        req.user.id,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Payment gateway config fetched successfully",
        data: result,
    });
});

const updateConfig = catchAsync(async (req, res) => {
    const result = await paymentGatewayService.updatePaymentGatewayConfig(
        req.user.id,
        req.body,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Payment gateway config updated successfully",
        data: result,
    });
});

export const paymentGatewayController = { getConfig, updateConfig };
