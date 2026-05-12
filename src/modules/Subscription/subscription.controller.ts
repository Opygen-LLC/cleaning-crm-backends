import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { subscriptionService } from "./subscription.service";

const getMySubscription = catchAsync(async (req, res) => {
	const user = req.user;
	const result = await subscriptionService.getMySubscription(user);

	sendResponse(res, {
		httpStatusCode: status.OK,
		success: true,
		message: "My subscription retrieved successfully",
		data: result,
	});
});

export const subscriptionController = {
	getMySubscription,
};