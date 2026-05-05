import { prisma } from "../../lib/prisma/prisma";
import {
  IInvoiceCreate,
  IInvoiceUpdate,
  IInvoiceFilters,
} from "./invoice.interface";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { UserRole, InvoiceStatus } from "../../generated/prisma/enums";

/**
 * Generates a unique invoice reference in the format #OP-INV-0001
 */
const generateInvoiceRef = async () => {
  const lastInvoice = await prisma.invoice.findFirst({
    orderBy: { createdAt: "desc" },
    select: { invoiceRef: true },
  });

  let nextNumber = 1;

  if (lastInvoice && lastInvoice.invoiceRef) {
    const parts = lastInvoice.invoiceRef.split("-");
    if (parts.length === 3) {
      const lastNumber = parseInt(parts[2]);
      if (!isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }
  }

  const formattedNumber = nextNumber.toString().padStart(4, "0");
  return `#OP-INV-${formattedNumber}`;
};

const createInvoice = async (payload: IInvoiceCreate, user: any) => {
  const adminProfile = await prisma.adminProfile.findUnique({
    where: { userId: user.id },
  });

  if (!adminProfile) {
    throw new AppError(status.NOT_FOUND, "Admin profile not found");
  }

  const serviceCatalog = await prisma.serviceCatalog.findUnique({
    where: { id: payload.serviceCatalogId },
  });

  if (!serviceCatalog) {
    throw new AppError(status.NOT_FOUND, "Service not found in catalog");
  }

  const { clientDetails, dates, summary, ...invoiceData } = payload;
  
  const invoiceRef = await generateInvoiceRef();

  return await prisma.invoice.create({
    data: {
      ...invoiceData,
      invoiceRef,
      adminId: adminProfile.id,
      clientName: clientDetails.clientName,
      clientEmail: clientDetails.email,
      serviceAddress: clientDetails.serviceAddress,
      linkedBookingRef: clientDetails.linkedBookingRef,
      issuedDate: new Date(dates.issueDate),
      dueDate: new Date(dates.dueDate),
      subtotal: summary.subtotal,
      taxRate: summary.taxRate,
      taxAmount: summary.taxAmount,
      total: summary.total,
      lineItems: payload.lineItems as any,
    },
  });
};

const getAllInvoices = async (filters: IInvoiceFilters, user: any) => {
  const { searchTerm, status: invoiceStatus, adminId } = filters;
  const andConditions: any[] = [];

  if (searchTerm) {
    andConditions.push({
      OR: [
        { invoiceRef: { contains: searchTerm, mode: "insensitive" } },
        { clientName: { contains: searchTerm, mode: "insensitive" } },
        { clientEmail: { contains: searchTerm, mode: "insensitive" } },
      ],
    });
  }

  if (invoiceStatus) {
    andConditions.push({ status: invoiceStatus });
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

  return await prisma.invoice.findMany({
    where: whereConditions,
    include: {
      serviceCatalog: {
        select: {
          id: true,
          serviceName: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });
};

const getInvoiceById = async (id: string) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      serviceCatalog: {
        select: {
          id: true,
          serviceName: true,
        },
      },
    },
  });

  if (!invoice) {
    throw new AppError(status.NOT_FOUND, "Invoice not found");
  }

  return invoice;
};

const updateInvoice = async (id: string, payload: IInvoiceUpdate) => {
  const invoice = await prisma.invoice.findUnique({ where: { id } });

  if (!invoice) {
    throw new AppError(status.NOT_FOUND, "Invoice not found");
  }

  const { clientDetails, dates, summary, ...updateData } = payload;

  const data: any = { ...updateData };

  if (clientDetails) {
    if (clientDetails.clientName) data.clientName = clientDetails.clientName;
    if (clientDetails.email) data.clientEmail = clientDetails.email;
    if (clientDetails.serviceAddress) data.serviceAddress = clientDetails.serviceAddress;
    if (clientDetails.linkedBookingRef) data.linkedBookingRef = clientDetails.linkedBookingRef;
  }

  if (dates) {
    if (dates.issueDate) data.issuedDate = new Date(dates.issueDate);
    if (dates.dueDate) data.dueDate = new Date(dates.dueDate);
  }

  if (summary) {
    if (summary.subtotal !== undefined) data.subtotal = summary.subtotal;
    if (summary.taxRate !== undefined) data.taxRate = summary.taxRate;
    if (summary.taxAmount !== undefined) data.taxAmount = summary.taxAmount;
    if (summary.total !== undefined) data.total = summary.total;
  }

  if (payload.lineItems) {
    data.lineItems = payload.lineItems as any;
  }

  return await prisma.invoice.update({
    where: { id },
    data,
  });
};

const updateInvoiceStatus = async (id: string, invoiceStatus: InvoiceStatus) => {
  const invoice = await prisma.invoice.findUnique({ where: { id } });

  if (!invoice) {
    throw new AppError(status.NOT_FOUND, "Invoice not found");
  }

  const data: any = { status: invoiceStatus };
  if (invoiceStatus === InvoiceStatus.PAID) {
    data.paidDate = new Date();
  } else if (invoiceStatus === InvoiceStatus.SENT) {
    data.sentAt = new Date();
  }

  return await prisma.invoice.update({
    where: { id },
    data,
  });
};

const deleteInvoice = async (id: string) => {
  const invoice = await prisma.invoice.findUnique({ where: { id } });

  if (!invoice) {
    throw new AppError(status.NOT_FOUND, "Invoice not found");
  }

  return await prisma.invoice.delete({
    where: { id },
  });
};

export const invoiceService = {
  createInvoice,
  getAllInvoices,
  getInvoiceById,
  updateInvoice,
  updateInvoiceStatus,
  deleteInvoice,
};
