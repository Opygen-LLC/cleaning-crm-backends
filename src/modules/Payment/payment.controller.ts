import httpStatus from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { paymentService } from "./payment.service";
import { IPaymentFilters } from "./payment.interface";
import { PaymentMethod, PaymentStatus } from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";

const createPayment = catchAsync(async (req, res) => {
  const result = await paymentService.createPayment(req.body, req.user);

  sendResponse(res, {
    httpStatusCode: httpStatus.CREATED,
    success: true,
    message: "Payment recorded successfully",
    data: result,
  });
});

const getAllPayments = catchAsync(async (req, res) => {
  const filters: IPaymentFilters = {
    page:       req.query.page ? Number(req.query.page) : 1,
    limit:      req.query.limit ? Number(req.query.limit) : 10,
    searchTerm: req.query.searchTerm as string,
    method:     req.query.method    as PaymentMethod,
    status:     req.query.status    as PaymentStatus,
    startDate:  req.query.startDate as string,
    endDate:    req.query.endDate   as string,
    invoiceId:  req.query.invoiceId as string,
  };

  const result = await paymentService.getAllPayments(filters, req.user);

  sendResponse(res, {
    httpStatusCode: httpStatus.OK,
    success: true,
    message: "Payments retrieved successfully",
    data: result,
  });
});

const getPaymentById = catchAsync(async (req, res) => {
  const result = await paymentService.getPaymentById(req.params.id as string, req.user);

  sendResponse(res, {
    httpStatusCode: httpStatus.OK,
    success: true,
    message: "Payment retrieved successfully",
    data: result,
  });
});

const updatePayment = catchAsync(async (req, res) => {
  const result = await paymentService.updatePayment(
    req.params.id as string,
    req.body,
    req.user,
  );

  sendResponse(res, {
    httpStatusCode: httpStatus.OK,
    success: true,
    message: "Payment updated successfully",
    data: result,
  });
});

const deletePayment = catchAsync(async (req, res) => {
  const result = await paymentService.deletePayment(req.params.id as string, req.user);

  sendResponse(res, {
    httpStatusCode: httpStatus.OK,
    success: true,
    message: "Payment deleted successfully",
    data: result,
  });
});

const uploadReceipt = catchAsync(async (req, res) => {
  if (!req.file) {
    throw new AppError(httpStatus.BAD_REQUEST, "Receipt file is required");
  }

  const result = await paymentService.uploadReceipt(
    req.params.id as string,
    req.file,
    req.user,
  );

  sendResponse(res, {
    httpStatusCode: httpStatus.OK,
    success: true,
    message: "Receipt uploaded successfully",
    data: result,
  });
});

export const paymentController = {
  createPayment,
  getAllPayments,
  getPaymentById,
  updatePayment,
  deletePayment,
  uploadReceipt,
};
