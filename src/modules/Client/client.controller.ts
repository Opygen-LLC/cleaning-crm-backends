import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { clientService } from "./client.service";

const createClient = catchAsync(async (req, res) => {
    const { adminId } = req.params;
	const user = req.user;
	const result = await clientService.createClient(adminId as string, req.body, user);

	sendResponse(res, {
		httpStatusCode: status.CREATED,
		success: true,
		message: "Client created successfully",
		data: result,
	});
});

export const clientController = {
    createClient,
};
