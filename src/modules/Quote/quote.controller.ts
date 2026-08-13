import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { quoteService } from "./quote.service";
import { IQueryParams } from "../../interface/query.interface";

// ── CRUD ──────────────────────────────────────────────────────────────────────

const createQuote = catchAsync(async (req, res) => {
    const result = await quoteService.createQuote(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Quote created successfully",
        data: result,
    });
});

const getAllQuotes = catchAsync(async (req, res) => {
    const queryParams = req.query as IQueryParams;

    const result = await quoteService.getAllQuotes(queryParams, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quotes retrieved successfully",
        data: result.data,
        meta: result.meta,
    });
});

const getQuoteById = catchAsync(async (req, res) => {
    const result = await quoteService.getQuoteById(
        req.params.id as string,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote retrieved successfully",
        data: result,
    });
});

const updateQuote = catchAsync(async (req, res) => {
    const result = await quoteService.updateQuote(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote updated successfully",
        data: result,
    });
});

const updateQuoteStatus = catchAsync(async (req, res) => {
    const result = await quoteService.updateQuoteStatus(
        req.params.id as string,
        req.body.status,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote status updated successfully",
        data: result,
    });
});

const deleteQuote = catchAsync(async (req, res) => {
    await quoteService.deleteQuote(req.params.id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote deleted successfully",
        data: null,
    });
});

// ── Convert to Booking ────────────────────────────────────────────────────────

const convertQuoteToBooking = catchAsync(async (req, res) => {
    const result = await quoteService.convertQuoteToBooking(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Quote successfully converted to booking",
        data: result,
    });
});

// ── Public (unauthenticated) ──────────────────────────────────────────────────

const getPublicQuote = catchAsync(async (req, res) => {
    const result = await quoteService.getPublicQuote(req.params.token as string);

    // Public quote responses contain customer-specific commercial data and
    // must never be stored by browsers/CDNs/shared proxies.
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote retrieved successfully",
        data: result,
    });
});

const publicQuoteAction = catchAsync(async (req, res) => {
    const result = await quoteService.publicQuoteAction(
        req.params.token as string,
        req.body.action,
        req.body.note,
    );

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: `Quote ${req.body.action === "accept" ? "accepted" : "declined"} successfully`,
        data: result,
    });
});

// ── Send quote email ──────────────────────────────────────────────────────────

const sendQuoteEmail = catchAsync(async (req, res) => {
    const result = await quoteService.sendQuoteEmail(
        req.params.id as string,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote email sent successfully",
        data: result,
    });
});

// ── Quote Templates ───────────────────────────────────────────────────────────

const getAllQuoteTemplates = catchAsync(async (req, res) => {
    const result = await quoteService.getAllQuoteTemplates(req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote templates retrieved successfully",
        data: result,
    });
});

const createQuoteTemplate = catchAsync(async (req, res) => {
    const result = await quoteService.createQuoteTemplate(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Quote template created successfully",
        data: result,
    });
});

const updateQuoteTemplate = catchAsync(async (req, res) => {
    const result = await quoteService.updateQuoteTemplate(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote template updated successfully",
        data: result,
    });
});

const deleteQuoteTemplate = catchAsync(async (req, res) => {
    await quoteService.deleteQuoteTemplate(req.params.id as string, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Quote template deleted successfully",
        data: null,
    });
});

const convertQuoteToJob = catchAsync(async (req, res) => {
    const result = await quoteService.convertQuoteToJob(
        req.params.id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Quote converted to job successfully",
        data: result,
    });
});

// ── Export ────────────────────────────────────────────────────────────────────

export const quoteController = {
    createQuote,
    getAllQuotes,
    getQuoteById,
    updateQuote,
    updateQuoteStatus,
    deleteQuote,
    convertQuoteToBooking,
    convertQuoteToJob,
    getPublicQuote,
    publicQuoteAction,
    sendQuoteEmail,
    getAllQuoteTemplates,
    createQuoteTemplate,
    updateQuoteTemplate,
    deleteQuoteTemplate,
};
