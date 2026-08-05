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
            where: { id, booking: { clientId: req.portalClient.id } },
            select: { id: true },
        });
        if (!owned) {
            throw new AppError(status.NOT_FOUND, "Invoice not found");
        }
    }

    const pdfBuffer = await generateInvoicePDFBuffer(id as string);

    res.set({
        "Content-Type":        "application/pdf",
        // `attachment` triggers the browser's Save dialog.
        // Swap to `inline` if you want the PDF to open in the browser tab.
        "Content-Disposition": `attachment; filename="invoice-${id}.pdf"`,
        "Content-Length":      pdfBuffer.length.toString(),
        // Prevent CDN/reverse-proxy from caching personally-identifiable PDFs.
        "Cache-Control":       "no-store, no-cache, must-revalidate, private",
        "Pragma":              "no-cache",
    });

    res.status(status.OK).end(pdfBuffer);
});
