import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { invoiceService } from "./invoice.service";
import { IInvoiceFilters } from "./invoice.interface";
import { InvoiceStatus } from "../../generated/prisma/enums";

const createInvoice = catchAsync(async (req, res) => {
    const result = await invoiceService.createInvoice(req.body, req.user);

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Invoice created successfully",
        data: result,
    });
});

const getAllInvoices = catchAsync(async (req, res) => {
    const filters: IInvoiceFilters = {
        searchTerm: req.query.searchTerm as string,
        status: req.query.status as InvoiceStatus,
        adminId: req.query.adminId as string,
    };

    const result = await invoiceService.getAllInvoices(filters, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Invoices retrieved successfully",
        data: result,
    });
});

const getInvoiceById = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await invoiceService.getInvoiceById(id as string);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Invoice retrieved successfully",
        data: result,
    });
});

const updateInvoice = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await invoiceService.updateInvoice(id as string, req.body);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Invoice updated successfully",
        data: result,
    });
});

const updateInvoiceStatus = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status: invoiceStatus } = req.body;
    const result = await invoiceService.updateInvoiceStatus(
        id as string,
        invoiceStatus,
    );

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Invoice status updated successfully",
        data: result,
    });
});

const deleteInvoice = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await invoiceService.deleteInvoice(id as string);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Invoice deleted successfully",
        data: result,
    });
});

const getPaymentHistory = catchAsync(async (req, res) => {
    const filters = {
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 10,
        searchTerm: req.query.search as string | undefined,
        method: req.query.method as string | undefined,
        adminId: req.query.adminId as string | undefined,
    };

    const result = await invoiceService.getPaymentHistory(filters, req.user);

    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Payment history retrieved successfully",
        data: result,
    });
});

const recordPayment = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await invoiceService.recordPayment(
        id as string,
        req.body,
        req.user,
    );

    sendResponse(res, {
        httpStatusCode: status.CREATED,
        success: true,
        message: "Payment recorded successfully",
        data: result,
    });
});

const sendInvoice = catchAsync(async (req, res) => {
    const result = await invoiceService.sendInvoice(
        req.params["id"] as string,
        req.user,
    );
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Invoice sent to client successfully",
        data: result,
    });
});

const createPaymentLink = catchAsync(async (req, res) => {
    const { id } = req.params;
    const result = await invoiceService.createInvoicePaymentLink(id as string, req.user);
    sendResponse(res, {
        httpStatusCode: status.OK,
        success: true,
        message: "Stripe payment link created",
        data: result,
    });
});

export const invoiceController = {
    createInvoice,
    getAllInvoices,
    getInvoiceById,
    updateInvoice,
    updateInvoiceStatus,
    deleteInvoice,
    getPaymentHistory,
    recordPayment,
    sendInvoice,
    createPaymentLink,
};
