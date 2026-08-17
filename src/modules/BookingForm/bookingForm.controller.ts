import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { bookingFormService } from "./bookingForm.service";
import { bookingService } from "../Booking/booking.service";

const getParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

// ── BookingForm CRUD ──────────────────────────────────────────────────────────

const createBookingForm = catchAsync(async (req, res) => {
    const result = await bookingFormService.createBookingForm(req.body, req.user);
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Booking form created successfully",
        data: result,
    });
});

const getAllBookingForms = catchAsync(async (req, res) => {
    const result = await bookingFormService.getAllBookingForms(req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Booking forms retrieved successfully",
        data: result,
    });
});

const getBookingFormById = catchAsync(async (req, res) => {
    const result = await bookingFormService.getBookingFormById(
        getParam(req.params.id),
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Booking form retrieved successfully",
        data: result,
    });
});

const updateBookingForm = catchAsync(async (req, res) => {
    const result = await bookingFormService.updateBookingForm(
        getParam(req.params.id),
        req.body,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Booking form updated successfully",
        data: result,
    });
});

const deleteBookingForm = catchAsync(async (req, res) => {
    await bookingFormService.deleteBookingForm(getParam(req.params.id), req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Booking form deleted successfully",
        data: null,
    });
});

const togglePublished = catchAsync(async (req, res) => {
    const result = await bookingFormService.togglePublished(
        getParam(req.params.id),
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Booking form ${result.published ? "published" : "unpublished"} successfully`,
        data: result,
    });
});

// ── Submissions ───────────────────────────────────────────────────────────────

const getSubmissions = catchAsync(async (req, res) => {
    const formId = req.query.formId as string | undefined;
    const result = await bookingFormService.getSubmissions(formId, req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Submissions retrieved successfully",
        data: result,
    });
});

const getFormSubmissions = catchAsync(async (req, res) => {
    const result = await bookingFormService.getSubmissions(
        getParam(req.params.id),
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Submissions retrieved successfully",
        data: result,
    });
});

const updateSubmissionStatus = catchAsync(async (req, res) => {
    const result = await bookingFormService.updateSubmissionStatus(
        getParam(req.params.submissionId),
        req.body.status,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Submission status updated successfully",
        data: result,
    });
});

const convertSubmissionToBooking = catchAsync(async (req, res) => {
    const result = await bookingService.convertBookingFormSubmission(
        getParam(req.params.submissionId),
        req.body,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: result.alreadyConverted ? status.OK : status.CREATED,
        success: true,
        message: result.alreadyConverted ? "Submission was already converted" : "Submission converted to booking successfully",
        data: result,
    });
});

// ── Public (unauthenticated) ──────────────────────────────────────────────────

const getPublicBookingForm = catchAsync(async (req, res) => {
    const result = await bookingFormService.getPublicBookingForm(getParam(req.params.slug));
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Booking form retrieved successfully",
        data: result,
    });
});

const getPublicSlotAvailability = catchAsync(async (req, res) => {
    const slug = getParam(req.params.slug);
    const date = req.query.date as string;
    const result = await bookingFormService.getPublicSlotAvailability(slug, date);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Slot availability retrieved successfully",
        data: result,
    });
});

const submitPublicBookingForm = catchAsync(async (req, res) => {
    const result = await bookingFormService.submitPublicBookingForm(
        getParam(req.params.slug),
        req.body,
        req.get("Idempotency-Key") ?? undefined,
    );
    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Booking request submitted successfully. We'll confirm shortly!",
        data: result,
    });
});

// ── Export ────────────────────────────────────────────────────────────────────

export const bookingFormController = {
    createBookingForm,
    getAllBookingForms,
    getBookingFormById,
    updateBookingForm,
    deleteBookingForm,
    togglePublished,
    getSubmissions,
    getFormSubmissions,
    updateSubmissionStatus,
    convertSubmissionToBooking,
    getPublicBookingForm,
    getPublicSlotAvailability,
    submitPublicBookingForm,
};
