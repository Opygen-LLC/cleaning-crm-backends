import { prisma } from "../../lib/prisma/prisma";
import {
  IExpenseCreate,
  IExpenseUpdate,
  IExpenseFilters,
} from "./expense.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { UserRole, ExpenseCategory } from "../../generated/prisma/enums";
import { startOfMonth, endOfMonth, subMonths, subDays } from "date-fns";
import { getAdminId } from "../../lib/utils/resolveAdminId";

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
  const adminId = await getAdminId(user);
  const expenseRef = await generateExpenseRef();

  return await prisma.expense.create({
    data: {
      ...payload,
      expenseRef,
      adminId,
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
    andConditions.push({ adminId: await getAdminId(user) });
  }

  const whereConditions = andConditions.length > 0 ? { AND: andConditions } : {};

  const [result, total] = await Promise.all([
    prisma.expense.findMany({
      where: whereConditions,
      skip,
      take: limit,
      orderBy: { date: "desc" },
    }),
    prisma.expense.count({ where: whereConditions }),
  ]);

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
  const adminId = await getAdminId(user);
  const now = new Date();
  const currentMonthStart = startOfMonth(now);
  const currentMonthEnd = endOfMonth(now);
  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const lastMonthEnd = endOfMonth(subMonths(now, 1));
  const last30DaysStart = subDays(now, 30);

  type ExpenseStatsRow = {
    currentMonth: string | number | null;
    lastMonth: string | number | null;
    allTime: string | number | null;
    categories: unknown;
  };
  type CategoryRow = { category: string; amount: string | number | null };

  // One aggregate query replaces three SUM queries plus one GROUP BY query.
  const rows = await prisma.$queryRaw<ExpenseStatsRow[]>`
    WITH totals AS (
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE date BETWEEN ${currentMonthStart} AND ${currentMonthEnd}), 0) AS "currentMonth",
        COALESCE(SUM(amount) FILTER (WHERE date BETWEEN ${lastMonthStart} AND ${lastMonthEnd}), 0) AS "lastMonth",
        COALESCE(SUM(amount), 0) AS "allTime"
      FROM "expense"
      WHERE "adminId" = ${adminId}
    ), categories AS (
      SELECT category::text AS category, COALESCE(SUM(amount), 0) AS amount
      FROM "expense"
      WHERE "adminId" = ${adminId} AND date BETWEEN ${last30DaysStart} AND ${now}
      GROUP BY category
    )
    SELECT totals.*,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('category', category, 'amount', amount) ORDER BY category)
        FROM categories
      ), '[]'::jsonb) AS categories
    FROM totals
  `;

  const row = rows[0];
  const currentTotal = Number(row?.currentMonth ?? 0);
  const lastTotal = Number(row?.lastMonth ?? 0);
  const totalSpendAllTime = Number(row?.allTime ?? 0);
  const categories: CategoryRow[] = Array.isArray(row?.categories)
    ? (row!.categories as CategoryRow[])
    : [];

  let trendPercentage = 0;
  if (lastTotal > 0) trendPercentage = ((currentTotal - lastTotal) / lastTotal) * 100;
  else if (currentTotal > 0) trendPercentage = 100;

  return {
    totalSummary: {
      totalAllTime: totalSpendAllTime,
      currentMonth: currentTotal,
      lastMonth: lastTotal,
      trend: Number(trendPercentage.toFixed(2)),
      isUpTrend: currentTotal >= lastTotal,
    },
    categorySummary: categories.map((item) => ({
      category: item.category,
      amount: Number(item.amount ?? 0),
    })),
  };
};

const getExpenseSpendAnalysis = async (
  user: any,
  query: { startDate?: string; endDate?: string },
) => {
  const adminId = await getAdminId(user);
  const now = new Date();
  const endDate = query.endDate ? new Date(query.endDate) : now;
  const startDate = query.startDate ? new Date(query.startDate) : subDays(endDate, 30);

  // Fetch all categories from the enum
  const allCategories = Object.values(ExpenseCategory);

  // Group expenses by category in the range
  const categorySummary = await prisma.expense.groupBy({
    by: ["category"],
    where: {
      adminId,
      date: {
        gte: startDate,
        lte: endDate,
      },
    },
    _sum: {
      amount: true,
    },
  });

  // Map all categories, ensuring those with no spend are included with 0
  const analysisData = allCategories.map((cat) => {
    const summary = categorySummary.find((item) => item.category === cat);
    return {
      category: cat,
      amount: Number(summary?._sum.amount || 0),
    };
  });

  return analysisData;
};

export const expenseService = {
  createExpense,
  getAllExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  getExpenseStats,
  getExpenseSpendAnalysis,
};
