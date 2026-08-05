/**
 * estimate.pdf.controller.ts
 *
 * Handles GET /estimate/:id/pdf. Mirrors quote.pdf.controller.ts. Reachable
 * by an authenticated admin/staff session OR by a client's portal token —
 * ownership is checked here for the portal-token path.
 */

import { Request, Response } from "express";
import status from "http-status";
import { catchAsync } from "../../shared/catchAsync";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import { generateEstimatePDFBuffer } from "./estimate.pdf.service";

export const downloadEstimatePDF = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!id) {
        throw new AppError(status.BAD_REQUEST, "Estimate ID is required");
    }

    if (req.portalClient) {
        const owned = await prisma.estimate.findFirst({
            where: { id, clientId: req.portalClient.id },
            select: { id: true },
        });
        if (!owned) {
            throw new AppError(status.NOT_FOUND, "Estimate not found");
        }
    }

    const pdfBuffer = await generateEstimatePDFBuffer(id as string);

    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="estimate-${id}.pdf"`,
        "Content-Length": pdfBuffer.length.toString(),
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "Pragma": "no-cache",
    });

    res.status(status.OK).end(pdfBuffer);
});
