import { prisma } from "../../lib/prisma/prisma";
import {
  IExpenseCreate,
  IExpenseUpdate,
  IExpenseFilters,
} from "./expense.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { UserRole } from "../../generated/prisma/enums";
import { startOfMonth, endOfMonth, subMonths, subDays } from "date-fns";

/**
 * Generates a unique expense reference in the format #OP-EXP-0011
 */
const generateExpenseRef = async () => {
  const lastExpense = await prisma.expense.findFirst({
    orderBy: { createdAt: "desc" },
    select: { expenseRef: true },
  });

  let nextNumber = 1;

  if (lastExpense && lastExpense.expenseRef && lastExpense.expenseRef.includes("-")) {
    const parts = lastExpense.expenseRef.split("-");
    if (parts.length === 3) {
      const lastNumber = parseInt(parts[2]);
      if (!isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }
  }

  const formattedNumber = nextNumber.toString().padStart(4, "0");
  return `#OP-EXP-${formattedNumber}`;
};

const createExpense = async (payload: IExpenseCreate, user: any) => {
  const adminProfile = await prisma.adminProfile.findUnique({
    where: { userId: user.id },
  });

  if (!adminProfile) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  const expenseRef = await generateExpenseRef();

  return await prisma.expense.create({
    data: {
      ...payload,
      expenseRef,
      adminId: adminProfile.id,
      date: new Date(payload.date),
    },
  });
};

const getAllExpenses = async (
  filters: IExpenseFilters,
  paginationOptions: { page?: number; limit?: number },
  user: any,
) => {
  const { searchTerm, category, adminId, startDate, endDate } = filters;
  const { page = 1, limit = 10 } = paginationOptions;
  const skip = (page - 1) * limit;

  const andConditions: any[] = [];

  if (searchTerm) {
    andConditions.push({
      OR: [
        { description: { contains: searchTerm, mode: "insensitive" } },
        { expenseRef: { contains: searchTerm, mode: "insensitive" } },
        { paidBy: { contains: searchTerm, mode: "insensitive" } },
      ],
    });
  }

  if (category) {
    andConditions.push({ category });
  }

  if (startDate || endDate) {
    const dateFilter: any = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);
    andConditions.push({ date: dateFilter });
  }

  if (adminId) {
    andConditions.push({ adminId });
  } else if (user.role === UserRole.ADMIN) {
    const adminProfile = await prisma.adminProfile.findUnique({
      where: { userId: user.id },
    });
    if (adminProfile) {
      andConditions.push({ adminId: adminProfile.id });
    }
  }

  const whereConditions = andConditions.length > 0 ? { AND: andConditions } : {};

  const result = await prisma.expense.findMany({
    where: whereConditions,
    skip,
    take: limit,
    orderBy: {
      date: "desc",
    },
  });

  const total = await prisma.expense.count({ where: whereConditions });

  return {
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    data: result,
  };
};

const getExpenseById = async (id: string) => {
  const result = await prisma.expense.findUnique({
    where: { id },
    include: {
      admin: {
        select: {
          id: true,
          businessName: true,
        },
      },
    },
  });

  if (!result) {
    throw new AppError(status.NOT_FOUND, "Expense not found");
  }

  return result;
};

const updateExpense = async (id: string, payload: IExpenseUpdate) => {
  const isExist = await prisma.expense.findUnique({ where: { id } });

  if (!isExist) {
    throw new AppError(status.NOT_FOUND, "Expense not found");
  }

  return await prisma.expense.update({
    where: { id },
    data: {
      ...payload,
      date: payload.date ? new Date(payload.date) : undefined,
    },
  });
};

const deleteExpense = async (id: string) => {
  const isExist = await prisma.expense.findUnique({ where: { id } });

  if (!isExist) {
    throw new AppError(status.NOT_FOUND, "Expense not found");
  }

  return await prisma.expense.delete({
    where: { id },
  });
};

const getExpenseStats = async (user: any) => {
  const adminProfile = await prisma.adminProfile.findUnique({
    where: { userId: user.id },
  });

  if (!adminProfile) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  const adminId = adminProfile.id;
  const now = new Date();
  const currentMonthStart = startOfMonth(now);
  const currentMonthEnd = endOfMonth(now);
  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const lastMonthEnd = endOfMonth(subMonths(now, 1));
  const last30DaysStart = subDays(now, 30);

  // Current Month Total
  const currentMonthTotal = await prisma.expense.aggregate({
    where: {
      adminId,
      date: { gte: currentMonthStart, lte: currentMonthEnd },
    },
    _sum: { amount: true },
  });

  // Last Month Total
  const lastMonthTotal = await prisma.expense.aggregate({
    where: {
      adminId,
      date: { gte: lastMonthStart, lte: lastMonthEnd },
    },
    _sum: { amount: true },
  });

  // Total All Time
  const allTimeTotal = await prisma.expense.aggregate({
    where: {
      adminId,
    },
    _sum: { amount: true },
  });

  const currentTotal = Number(currentMonthTotal._sum.amount || 0);
  const lastTotal = Number(lastMonthTotal._sum.amount || 0);
  const totalSpendAllTime = Number(allTimeTotal._sum.amount || 0);

  // Calculate Trend
  let trendPercentage = 0;
  if (lastTotal > 0) {
    trendPercentage = ((currentTotal - lastTotal) / lastTotal) * 100;
  } else if (currentTotal > 0) {
    trendPercentage = 100;
  }

  // Group by Category (Last 30 Days - As requested)
  const categorySummary = await prisma.expense.groupBy({
    by: ["category"],
    where: {
      adminId,
      date: { gte: last30DaysStart, lte: now },
    },
    _sum: { amount: true },
  });

  return {
    totalSummary: {
      totalAllTime: totalSpendAllTime,
      currentMonth: currentTotal,
      lastMonth: lastTotal,
      trend: Number(trendPercentage.toFixed(2)),
      isUpTrend: currentTotal >= lastTotal,
    },
    categorySummary: categorySummary.map((item) => ({
      category: item.category,
      amount: Number(item._sum.amount || 0),
    })),
  };
};

export const expenseService = {
  createExpense,
  getAllExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  getExpenseStats,
};
