import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { generateSimpleDocumentPDFBuffer } from "../../shared/pdf/simpleDocumentPdf";

export const generateEstimatePDFBuffer = async (estimateId: string): Promise<Buffer> => {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: { client: true, lineItems: true },
    });

    if (!estimate) {
        throw new AppError(status.NOT_FOUND, "Estimate not found");
    }

    return generateSimpleDocumentPDFBuffer({
        docTypeLabel: "ESTIMATE",
        ref: estimate.estimateRef,
        status: estimate.status,
        issuedOrSentLabel: "SENT",
        issuedOrSentDate: estimate.sentAt,
        validUntil: estimate.validUntil,
        clientName: estimate.client.name,
        clientEmail: estimate.client.email,
        address: estimate.address,
        lineItems: estimate.lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            total: li.total,
        })),
        subtotal: estimate.subtotal,
        taxRate: estimate.taxRate,
        taxAmount: estimate.tax,
        total: estimate.total,
        notes: estimate.notes,
    });
};
