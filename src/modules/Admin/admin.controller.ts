import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { adminService } from "./admin.service";

const updateAdmin = catchAsync(async (req, res) => {
    const userId = req.user.id;
    const payload = req.body;

    if (req.file?.path) {
        payload.businessLogo = req.file.path; // 👈 Cloudinary URL
    }

    const result = await adminService.updateAdmin(userId, payload);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin updated successfully",
        data: result,
    });
});

export const adminController = {
    updateAdmin,
};
