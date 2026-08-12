/**
 * invoice.pdf.controller.ts
 *
 * Handles GET /invoice/:id/pdf
 * Streams the generated PDF back to the client with the correct headers.
 *
 * Follows the same catchAsync / AppError patterns used everywhere else in
 * this codebase — no new conventions introduced.
 */

import { Request, Response } from "express";
import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { generateInvoicePDFBuffer } from "./invoice.pdf.service";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import { UserRole } from "../../generated/prisma/enums";

export const downloadInvoicePDF = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id) {
        throw new AppError(status.BAD_REQUEST, "Invoice ID is required");
    }

    // When the request came in via the client portal token (no admin/staff
    // session), confirm the invoice actually belongs to a booking for that
    // client before generating anything — the id in the URL is otherwise
    // guessable and would leak other clients' invoices.
    if (req.portalClient) {
        const owned = await prisma.invoice.findFirst({
            where: { id: id as string, booking: { clientId: req.portalClient.id } },
            select: { id: true },
        });
        if (!owned) {
            throw new AppError(status.NOT_FOUND, "Invoice not found");
        }
    } else if (req.user?.role !== UserRole.SUPER_ADMIN) {
        if (!req.user) throw new AppError(status.UNAUTHORIZED, "Unauthorized");
        const adminId = await getAdminId(req.user);
        const owned = await prisma.invoice.findFirst({
            where: { id: id as string, adminId },
            select: { id: true },
        });
        if (!owned) throw new AppError(status.NOT_FOUND, "Invoice not found");
    }

    const { buffer: pdfBuffer, invoiceRef } = await generateInvoicePDFBuffer(id as string);
    const safeRef = invoiceRef.replace(/[^a-zA-Z0-9_-]/g, "");

    res.set({
        "Content-Type":        "application/pdf",
        // `attachment` triggers the browser's Save dialog.
        // Swap to `inline` if you want the PDF to open in the browser tab.
        "Content-Disposition": `attachment; filename="invoice-${safeRef}.pdf"`,
        "Content-Length":      pdfBuffer.length.toString(),
        // Prevent CDN/reverse-proxy from caching personally-identifiable PDFs.
        "Cache-Control":       "no-store, no-cache, must-revalidate, private",
        "Pragma":              "no-cache",
    });

    res.status(status.OK).end(pdfBuffer);
});
