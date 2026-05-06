import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import { sendResponse } from "../../shared/sendResponse";
import { expenseService } from "./expense.service";
import { IExpenseFilters } from "./expense.interface";
import { ExpenseCategory } from "../../generated/prisma/enums";

const createExpense = catchAsync(async (req, res) => {
  const result = await expenseService.createExpense(req.body, req.user);

  sendResponse(res, {
    httpStatusCode: status.CREATED,
    success: true,
    message: "Expense created successfully",
    data: result,
  });
});

const getAllExpenses = catchAsync(async (req, res) => {
  const filters: IExpenseFilters = {
    searchTerm: req.query.searchTerm as string,
    category: req.query.category as ExpenseCategory,
    adminId: req.query.adminId as string,
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string,
  };

  const paginationOptions = {
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
  };

  const result = await expenseService.getAllExpenses(
    filters,
    paginationOptions,
    req.user,
  );

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Expenses retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getExpenseById = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await expenseService.getExpenseById(id as string);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Expense retrieved successfully",
    data: result,
  });
});

const updateExpense = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await expenseService.updateExpense(id as string, req.body);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Expense updated successfully",
    data: result,
  });
});

const deleteExpense = catchAsync(async (req, res) => {
  const { id } = req.params;
  const result = await expenseService.deleteExpense(id as string);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Expense deleted successfully",
    data: result,
  });
});

const getExpenseStats = catchAsync(async (req, res) => {
  const result = await expenseService.getExpenseStats(req.user);

  sendResponse(res, {
    httpStatusCode: status.OK,
    success: true,
    message: "Expense statistics retrieved successfully",
    data: result,
  });
});

export const expenseController = {
  createExpense,
  getAllExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  getExpenseStats,
};
