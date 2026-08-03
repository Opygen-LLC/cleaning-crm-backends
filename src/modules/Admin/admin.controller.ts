import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { adminService } from "./admin.service";
import { uploadToCloudinary } from "../../lib/utils/cloudinary";

const getAdmin = catchAsync(async (req, res) => {
    const userId = req.user.id;

    const result = await adminService.getAdmin(userId);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin profile fetched successfully",
        data: result,
    });
});

const updateAdmin = catchAsync(async (req, res) => {
    const userId = req.user.id;
    const payload = req.body;

    // FIX: previously relied on multer-storage-cloudinary populating
    // req.file.path with the uploaded Cloudinary URL. That package pins a
    // peer dependency on cloudinary@^1.x, which conflicts with this project's
    // cloudinary@^2.x and breaks `npm install` on any strict resolver.
    // Switched to multerMemory (buffer in req.file.buffer) + the same
    // uploadToCloudinary() stream-upload helper Staff/User avatar uploads
    // already use, so multer-storage-cloudinary is no longer a dependency.
    if (req.file) {
        const uploadResult = await uploadToCloudinary(req.file.buffer, {
            folder: "Cleaning-CRM/business-logos",
            public_id: `admin_${userId}_logo`,
            overwrite: true,
        });
        payload.businessLogo = uploadResult.secure_url;
    }

    const result = await adminService.updateAdmin(userId, payload);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin updated successfully",
        data: result,
    });
});

const updateWorkLocation = catchAsync(async (req, res) => {
    const userId = req.user.id;
    const locationId = req.params.id;
    const payload = req.body;

    const result = await adminService.updateWorkLocation(
        userId,
        locationId as string,
        payload,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Work location updated successfully",
        data: result,
    });
});

const deleteWorkLocation = catchAsync(async (req, res) => {
    const userId = req.user.id;
    const locationId = req.params.id;

    const result = await adminService.deleteWorkLocation(
        userId,
        locationId as string,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Work location deleted successfully",
        data: result,
    });
});

const getAdminUsage = catchAsync(async (req, res) => {
    const userId = req.user.id;

    const result = await adminService.getAdminUsage(userId);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Admin usage fetched successfully",
        data: result,
    });
});

const getOnboardingStatus = catchAsync(async (req, res) => {
    const userId = req.user.id;

    const result = await adminService.getOnboardingStatus(userId);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Onboarding status fetched successfully",
        data: result,
    });
});

const skipOnboardingStep = catchAsync(async (req, res) => {
    const userId = req.user.id;
    const { step } = req.body;

    const result = await adminService.skipOnboardingStep(userId, step);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Onboarding step skipped successfully",
        data: result,
    });
});

const skipAllOnboarding = catchAsync(async (req, res) => {
    const userId = req.user.id;

    const result = await adminService.skipAllOnboarding(userId);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "All onboarding steps skipped successfully",
        data: result,
    });
});

export const adminController = {
    getAdmin,
    updateAdmin,
    updateWorkLocation,
    deleteWorkLocation,
    getAdminUsage,
    getOnboardingStatus,
    skipOnboardingStep,
    skipAllOnboarding,
};

