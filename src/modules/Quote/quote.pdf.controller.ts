/**
 * quote.pdf.controller.ts
 *
 * Handles GET /quote/:id/pdf. Mirrors invoice.pdf.controller.ts's shape and
 * conventions. Reachable by an authenticated admin/staff session OR by a
 * client's portal token — ownership is checked here for the portal-token
 * path since the quote id in the URL is otherwise guessable.
 */

import { Request, Response } from "express";
import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { generateQuotePDFBuffer } from "./quote.pdf.service";

export const downloadQuotePDF = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id) {
        throw new AppError(status.BAD_REQUEST, "Quote ID is required");
    }

    if (req.portalClient) {
        const owned = await prisma.quote.findFirst({
            where: { id: id as string, clientId: req.portalClient.id },
            select: { id: true },
        });
        if (!owned) {
            throw new AppError(status.NOT_FOUND, "Quote not found");
        }
    }

    const pdfBuffer = await generateQuotePDFBuffer(id as string);

    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="quote-${id}.pdf"`,
        "Content-Length": pdfBuffer.length.toString(),
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "Pragma": "no-cache",
    });

    res.status(status.OK).end(pdfBuffer);
});
