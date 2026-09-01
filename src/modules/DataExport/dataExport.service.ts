import { deflateRawSync } from "node:zlib";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type { DataExportRequest } from "./dataExport.schema";
import type { DataExportSection } from "./dataExport.projections";
import {
  bookingExportSelect,
  bookingSubmissionExportSelect,
  clientExportSelect,
  estimateExportSelect,
  estimateSubmissionExportSelect,
  expenseExportSelect,
  followUpExportSelect,
  invoiceExportSelect,
  jobExportSelect,
  leadExportSelect,
  paymentExportSelect,
  profileExportSelect,
  quoteExportSelect,
  serviceExportSelect,
  staffExportSelect,
} from "./dataExport.projections";

const CHUNK_SIZE = 500;

type ExportRow = Record<string, unknown>;
type ExportSheet = { name: string; rows: ExportRow[] };

const json = (value: unknown) => {
  if (value == null) return "";
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") return current.toString();
    return current;
  });
};

const decimal = (value: unknown) => {
  if (value == null) return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : String(value);
};

const collectById = async <T extends { id: string }>(
  fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
): Promise<T[]> => {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor, CHUNK_SIZE);
    rows.push(...page);
    if (page.length < CHUNK_SIZE) break;
    cursor = page[page.length - 1]?.id;
    if (!cursor) break;
  }
  return rows;
};

const assignmentSummary = (rows: Array<{ staffId: string; staff: { user: { name: string; email: string } } }>) =>
  rows.map((row) => `${row.staff.user.name} <${row.staff.user.email}> [${row.staffId}]`).join("; ");

const loadSection = async (section: DataExportSection, adminId: string): Promise<ExportSheet> => {
  switch (section) {
    case "profile": { // Security credentials and capability tokens are deliberately excluded.
      const profile = await prisma.adminProfile.findFirst({ where: { id: adminId }, select: profileExportSelect });
      if (!profile) throw new AppError(status.NOT_FOUND, "Admin profile not found");
      return {
        name: "Profile",
        rows: [{
          "Profile ID": profile.id,
          "Business Name": profile.businessName,
          "Business Logo": profile.businessLogo,
          "Brand Color": profile.brandColor,
          "Business Email": profile.businessEmail,
          "Business Phone": profile.mobileNumber,
          Address: profile.address,
          City: profile.city,
          "Postal Code": profile.zipcode,
          Country: profile.country,
          Currency: profile.currency,
          "Business Type": profile.businessType,
          "License Number": profile.licenseNumber,
          "Business Description": profile.businessDescription,
          Website: profile.website,
          "Business Hours": json(profile.businessHours),
          "Onboarding Completed Steps": profile.onboardingCompletedSteps.join("; "),
          "Onboarding Completed At": profile.onboardingCompletedAt,
          "Skipped Steps": profile.skippedSteps.join("; "),
          "Owner User ID": profile.user.id,
          "Owner Name": profile.user.name,
          "Owner Email": profile.user.email,
          "Owner Role": profile.user.role,
          "Owner Status": profile.user.status,
          "Account Created": profile.createdAt,
          "Account Updated": profile.updatedAt,
        }],
      };
    }
    case "clients": {
      const rows = await collectById((cursor, take) => prisma.client.findMany({
        where: { adminId }, select: clientExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Clients", rows: rows.map((r) => ({
        "Client ID": r.id, Name: r.name, Email: r.email, Phone: r.phone, Status: r.status,
        "Service Preference": r.servicePreference, "Address Line 1": r.addressLine1,
        "Address Line 2": r.addressLine2, City: r.city, "Postal Code": r.zipcode, Country: r.country,
        "Total Spend": decimal(r.totalSpend), "Total Bookings": r.totalBookings,
        "Last Booking Date": r.lastBookingDate, Latitude: r.latitude, Longitude: r.longitude, "Geocoded At": r.geocodedAt,
        Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "leads": {
      const rows = await collectById((cursor, take) => prisma.lead.findMany({
        where: { adminId }, select: leadExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Leads", rows: rows.map((r) => ({
        "Lead ID": r.id, "Lead Ref": r.leadRef, Name: r.name, Email: r.email, Phone: r.phone,
        Stage: r.stage, "Service Interest": r.serviceInterest, "Service Catalog ID": r.serviceCatalogId,
        "Estimated Min": decimal(r.estimatedMin), "Estimated Max": decimal(r.estimatedMax), Notes: r.notes,
        "Source Ref": r.sourceRef, "Source Website ID": r.sourceWebsiteId,
        "Converted Client ID": r.convertedClientId, "Converted At": r.convertedAt,
        "Last Contacted At": r.lastContactedAt, Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "followUps": {
      const rows = await collectById((cursor, take) => prisma.leadActivity.findMany({
        where: { adminId, type: "FOLLOW_UP" }, select: followUpExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Lead Followups", rows: rows.map((r) => ({
        "Activity ID": r.id, "Lead ID": r.leadId, "Lead Ref": r.lead.leadRef, "Lead Name": r.lead.name,
        "Lead Email": r.lead.email, Status: r.status, "Scheduled At": r.scheduledAt,
        "Completed At": r.completedAt, "Assigned User ID": r.assignedToUserId,
        "Assigned To": r.assignedTo?.name ?? "", "Assigned Email": r.assignedTo?.email ?? "",
        Note: r.note, Outcome: r.outcome, "Created By User ID": r.createdBy, Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "services": {
      const rows = await collectById((cursor, take) => prisma.serviceCatalog.findMany({
        where: { adminId }, select: serviceExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Services", rows: rows.map((r) => ({
        "Service ID": r.id, Name: r.serviceName, Description: r.description, "Base Price": r.basePrice,
        Duration: r.duration, Category: r.category, Status: r.status, "Online Booking Enabled": r.onlineBookingEnabled,
        "Legacy Service Type": r.legacyServiceType,
        "Add Ons": json(r.addOns), Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "bookings": {
      const rows = await collectById((cursor, take) => prisma.booking.findMany({
        where: { adminId }, select: bookingExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Bookings", rows: rows.map((r) => ({
        "Booking ID": r.id, "Booking Ref": r.bookingRef, Status: r.status, "Client ID": r.clientId,
        "Client Name": r.client.name, "Client Email": r.client.email, "Service Catalog ID": r.serviceCatalogId,
        "Legacy Service Type": r.serviceType, Service: r.serviceNameSnapshot, "Price Snapshot": decimal(r.priceSnapshot),
        "Duration Snapshot": r.durationSnapshot, "Add-on Snapshot": json(r.addOnSnapshot), Address: r.address, "Scheduled Date": r.scheduledDate,
        "Duration Minutes": r.durationMins, Total: decimal(r.total), Notes: r.notes, "Quote ID": r.quoteId,
        "Recurring Schedule ID": r.recurringScheduleId, "Assigned Staff": assignmentSummary(r.staffAssignments),
        Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "jobs": {
      const rows = await collectById((cursor, take) => prisma.job.findMany({
        where: { adminId }, select: jobExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Jobs", rows: rows.map((r) => ({
        "Job ID": r.id, "Job Ref": r.jobRef, Status: r.status, "Client ID": r.clientId,
        "Client Name": r.client.name, "Client Email": r.client.email, "Booking ID": r.bookingId,
        "Quote ID": r.quoteId, "Estimate ID": r.estimateId, "Service Catalog ID": r.serviceCatalogId,
        "Legacy Service Type": r.serviceType, Service: r.serviceNameSnapshot, "Price Snapshot": decimal(r.priceSnapshot),
        "Duration Snapshot": r.durationSnapshot, Address: r.address, Latitude: r.latitude, Longitude: r.longitude,
        "Geocoded At": r.geocodedAt, "Scheduled Date": r.scheduledDate,
        "Duration Minutes": r.durationMins, Notes: r.notes,
        "Assigned Staff": assignmentSummary(r.staffAssignments),
        "Staff Time": json(r.staffAssignments.map((a) => ({ staffId: a.staffId, checkInAt: a.checkInAt, checkOutAt: a.checkOutAt, hoursWorked: decimal(a.hoursWorked) }))),
        Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "staff": {
      const rows = await collectById((cursor, take) => prisma.staffProfile.findMany({
        where: { adminId }, select: staffExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Staff", rows: rows.map((r) => ({
        "Staff ID": r.id, "User ID": r.userId, Name: r.user.name, Email: r.user.email,
        "User Status": r.user.status, Role: r.staffRole, Phone: r.mobileNumber, Address: r.address,
        Latitude: r.latitude, Longitude: r.longitude, "Geocoded At": r.geocodedAt,
        "Hourly Rate": r.hourlyRate, "Start Date": r.startDate, Specialisations: r.specialty.join("; "),
        Status: r.status, "Manually Inactive": r.manuallyInactive, "Emergency Contact": r.emergencyName, "Emergency Phone": r.emergencyMobileNumber,
        "Admin Note": r.adminNote, Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "quotes": {
      const rows = await collectById((cursor, take) => prisma.quote.findMany({
        where: { adminId }, select: quoteExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Quotes", rows: rows.map((r) => ({
        "Quote ID": r.id, "Quote Ref": r.quoteRef, Status: r.status, "Client ID": r.clientId,
        "Client Name": r.client.name, "Client Email": r.client.email, "Service Catalog ID": r.serviceCatalogId,
        "Legacy Service Type": r.serviceType, Service: r.serviceNameSnapshot, Address: r.address, Subtotal: decimal(r.subtotal), "Tax Rate": decimal(r.taxRate),
        Tax: decimal(r.tax), Total: decimal(r.total), "Valid Until": r.validUntil, Notes: r.notes,
        "Internal Notes": r.internalNotes, "Sent At": r.sentAt, "Responded At": r.respondedAt,
        "Response Note": r.responseNote, "Line Items": json(r.lineItems.map((item) => ({ ...item, unitPrice: decimal(item.unitPrice), total: decimal(item.total) }))),
        Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "estimates": {
      const rows = await collectById((cursor, take) => prisma.estimate.findMany({
        where: { adminId }, select: estimateExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Estimates", rows: rows.map((r) => ({
        "Estimate ID": r.id, "Estimate Ref": r.estimateRef, Status: r.status, "Client ID": r.clientId,
        "Client Name": r.client.name, "Client Email": r.client.email, "Service Catalog ID": r.serviceCatalogId,
        "Legacy Service Type": r.serviceType, Service: r.serviceNameSnapshot, Address: r.address, "Labour Cost": decimal(r.labourCost),
        "Material Cost": decimal(r.materialCost), "Overhead Cost": decimal(r.overheadCost),
        "Margin Percent": decimal(r.marginPercent), Subtotal: decimal(r.subtotal), "Tax Rate": decimal(r.taxRate),
        Tax: decimal(r.tax), Total: decimal(r.total), "Valid Until": r.validUntil, Notes: r.notes,
        "Internal Notes": r.internalNotes, "Sent At": r.sentAt, "Responded At": r.respondedAt,
        "Response Note": r.responseNote, "Converted Booking Ref": r.convertedToBookingRef,
        "Converted Quote Ref": r.convertedToQuoteRef,
        "Line Items": json(r.lineItems.map((item) => ({ ...item, unitPrice: decimal(item.unitPrice), total: decimal(item.total) }))),
        Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "invoices": {
      const rows = await collectById((cursor, take) => prisma.invoice.findMany({
        where: { adminId }, select: invoiceExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Invoices", rows: rows.map((r) => ({
        "Invoice ID": r.id, "Invoice Ref": r.invoiceRef, Status: r.status, "Client Name": r.clientName,
        "Client Email": r.clientEmail, "Service Address": r.serviceAddress, "Booking ID": r.bookingId,
        "Linked Booking Ref": r.linkedBookingRef, "Service Catalog ID": r.serviceCatalogId,
        Service: r.serviceNameSnapshot, "Line Items": json(r.lineItems), Notes: r.notes,
        "Issued Date": r.issuedDate, "Due Date": r.dueDate, "Paid Date": r.paidDate, "Sent At": r.sentAt,
        Subtotal: decimal(r.subtotal), "Tax Rate": decimal(r.taxRate), "Tax Amount": decimal(r.taxAmount),
        Total: decimal(r.total), Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "payments": {
      const rows = await collectById((cursor, take) => prisma.payment.findMany({
        where: { adminId }, select: paymentExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Payments", rows: rows.map((r) => ({
        "Payment ID": r.id, "Payment Ref": r.paymentRef, Amount: decimal(r.amount), Currency: r.currency,
        Method: r.method, Status: r.status, Note: r.note, "Transaction ID": r.transactionId,
        "Refund Amount": decimal(r.refundAmount), "Invoice ID": r.invoiceId,
        "Invoice Ref": r.invoice?.invoiceRef ?? "", "Invoice Client": r.invoice?.clientName ?? "",
        "Invoice Client Email": r.invoice?.clientEmail ?? "", "Paid At": r.paidAt,
        "Approved At": r.approvedAt, "Approved By User ID": r.approvedByUserId, "Rejection Reason": r.rejectionReason, Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "expenses": {
      const rows = await collectById((cursor, take) => prisma.expense.findMany({
        where: { adminId }, select: expenseExportSelect, orderBy: { id: "asc" }, take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }));
      return { name: "Expenses", rows: rows.map((r) => ({
        "Expense ID": r.id, "Expense Ref": r.expenseRef, Description: r.description, Category: r.category,
        Amount: decimal(r.amount), Date: r.date, "Paid By": r.paidBy, Recurring: r.isRecurring,
        Notes: r.notes, Created: r.createdAt, Updated: r.updatedAt,
      })) };
    }
    case "websiteSubmissions": {
      const [bookingRows, estimateRows] = await Promise.all([
        collectById((cursor, take) => prisma.bookingFormSubmission.findMany({
          where: { form: { adminId } }, select: bookingSubmissionExportSelect, orderBy: { id: "asc" }, take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        })),
        collectById((cursor, take) => prisma.estimateFormSubmission.findMany({
          where: { form: { adminId } }, select: estimateSubmissionExportSelect, orderBy: { id: "asc" }, take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        })),
      ]);
      const rows: ExportRow[] = [
        ...bookingRows.map((r) => ({
          Type: "Booking", "Submission ID": r.id, Ref: r.ref, Status: r.status, "Form ID": r.formId,
          "Source Website ID": r.sourceWebsiteId, Source: r.source, "Source Page": r.sourcePage,
          "UTM Source": r.utmSource, "UTM Campaign": r.utmCampaign, "Service Catalog ID": r.serviceCatalogId,
          "Legacy Service Type": r.serviceType, Service: r.serviceNameSnapshot, "Price Snapshot": decimal(r.priceSnapshot),
          "Duration Snapshot": r.durationSnapshot, "Add-on IDs": r.addOnIds.join("; "), "Add-on Snapshot": json(r.addOnSnapshot),
          "Total Snapshot": decimal(r.totalSnapshot), Name: r.name, Email: r.email, Phone: r.phone, Address: r.address,
          "Requested Date": r.date, "Time Slot": r.timeSlot, "Property Type": r.propertyType,
          Bedrooms: r.bedrooms, Bathrooms: r.bathrooms, Notes: r.notes, Answers: json(r.answers),
          "Converted Booking ID": r.convertedBookingId, "Converted At": r.convertedAt, Submitted: r.createdAt,
        })),
        ...estimateRows.map((r) => ({
          Type: "Estimate", "Submission ID": r.id, Ref: r.ref, Status: r.status, "Form ID": r.formId,
          "Source Website ID": r.sourceWebsiteId, "Service Catalog ID": r.serviceCatalogId,
          "Legacy Service Type": r.serviceType, Service: r.serviceNameSnapshot, "Price Snapshot": decimal(r.priceSnapshot),
          "Duration Snapshot": r.durationSnapshot, "Add-on IDs": r.addOnIds.join("; "), "Pricing Snapshot": json(r.pricingSnapshot),
          Name: r.name, Email: r.email, Phone: r.phone,
          Postcode: r.postcode, City: r.city, Bedrooms: r.bedrooms, Bathrooms: r.bathrooms, Notes: r.notes,
          Answers: json(r.answers), "Estimated Min": decimal(r.estimatedMin), "Estimated Max": decimal(r.estimatedMax),
          Submitted: r.createdAt,
        })),
      ];
      rows.sort((a, b) => new Date(String(a.Submitted)).getTime() - new Date(String(b.Submitted)).getTime());
      return { name: "Website Submissions", rows };
    }
  }
};

const xmlEscape = (value: string) => value
  // XML 1.0 forbids most C0 controls; remove them so arbitrary CRM notes or
  // form answers cannot corrupt the generated workbook package.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const colName = (index: number) => {
  let value = index + 1;
  let out = "";
  while (value > 0) {
    value -= 1;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
};

const scalar = (value: unknown): string | number | boolean => {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return json(value);
};

const worksheetXml = (sheet: ExportSheet) => {
  const headers = sheet.rows.length > 0 ? Object.keys(sheet.rows[0]) : ["No data"];
  const dataRows = sheet.rows.length > 0 ? sheet.rows : [{ "No data": "No records found for this section." }];
  const widths = headers.map((header) => {
    let width = header.length;
    for (const row of dataRows.slice(0, 200)) width = Math.max(width, String(scalar(row[header])).length);
    return Math.min(42, Math.max(10, width + 2));
  });
  const cols = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("");
  const renderCell = (value: unknown, ref: string, header = false) => {
    const normalized = scalar(value);
    if (typeof normalized === "number" && Number.isFinite(normalized)) {
      return `<c r="${ref}"${header ? ' s="1"' : ""}><v>${normalized}</v></c>`;
    }
    if (typeof normalized === "boolean") {
      return `<c r="${ref}" t="b"${header ? ' s="1"' : ""}><v>${normalized ? 1 : 0}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlEscape(String(normalized))}</t></is></c>`;
  };
  const headerRow = `<row r="1">${headers.map((h, i) => renderCell(h, `${colName(i)}1`, true)).join("")}</row>`;
  const rows = dataRows.map((row, rowIndex) => {
    const r = rowIndex + 2;
    return `<row r="${r}">${headers.map((h, i) => renderCell(row[h], `${colName(i)}${r}`)).join("")}</row>`;
  }).join("");
  const endCell = `${colName(headers.length - 1)}${dataRows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${endCell}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${cols}</cols><sheetData>${headerRow}${rows}</sheetData><autoFilter ref="A1:${colName(headers.length - 1)}1"/></worksheet>`;
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const dosDateTime = (date = new Date()) => {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
};

const zipArchive = (entries: Array<{ name: string; data: Buffer }>): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const method = 8; // ZIP DEFLATE
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]);
};

const buildWorkbook = (sheets: ExportSheet[]): Buffer => {
  const safeNames = sheets.map((sheet, index) => {
    const cleaned = sheet.name.replace(/[\\/*?:\[\]]/g, " ").trim().slice(0, 31) || `Sheet ${index + 1}`;
    return cleaned;
  });
  const sheetEntries = sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${index + 1}.xml`, data: Buffer.from(worksheetXml(sheet), "utf8"),
  }));
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_sheet, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safeNames.map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_sheet, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  return zipArchive([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(rootRels) },
    { name: "xl/workbook.xml", data: Buffer.from(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels) },
    { name: "xl/styles.xml", data: Buffer.from(styles) },
    ...sheetEntries,
  ]);
};

const createDataExport = async (payload: DataExportRequest, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const sheets: ExportSheet[] = [];
  // Sequential section processing intentionally caps concurrent DB pressure;
  // high-volume tables themselves are read in 500-row keyset chunks.
  for (const section of payload.sections) sheets.push(await loadSection(section, adminId));
  const buffer = buildWorkbook(sheets);
  const date = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `cleancrm-data-export-${date}.xlsx` };
};

export const dataExportService = { createDataExport };
