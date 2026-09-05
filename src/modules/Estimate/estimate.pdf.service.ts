import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { generateSimpleDocumentPDFBuffer } from "../../shared/pdf/simpleDocumentPdf";

export const generateEstimatePDFBuffer = async (estimateId: string): Promise<Buffer> => {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: { client: true, lineItems: true, admin: { select: { currency: true, businessName: true, businessEmail: true, brandColor: true } } },
    });

    if (!estimate) {
        throw new AppError(status.NOT_FOUND, "Estimate not found");
    }

    return generateSimpleDocumentPDFBuffer({
        docTypeLabel: "ESTIMATE",
        ref: estimate.estimateRef,
        status: estimate.status,
        issuedOrSentLabel: estimate.sentAt ? "SENT" : estimate.publishedAt ? "PUBLISHED" : "ISSUED",
        issuedOrSentDate: estimate.sentAt ?? estimate.publishedAt ?? estimate.createdAt,
        validUntil: estimate.validUntil,
        clientName: estimate.client.name,
        clientEmail: estimate.client.email,
        address: estimate.address,
        lineItems: estimate.lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice.toString(),
            total: li.total.toString(),
        })),
        subtotal: estimate.subtotal.toString(),
        taxRate: estimate.taxRate.toString(),
        taxAmount: estimate.tax.toString(),
        total: estimate.pricingType === "range" && estimate.estimatedMin != null && estimate.estimatedMax != null
            ? `${estimate.estimatedMin.toString()} – ${estimate.estimatedMax.toString()}`
            : estimate.total.toString(),
        notes: estimate.notes,
        businessName: estimate.admin.businessName,
        businessEmail: estimate.admin.businessEmail,
        brandColor: estimate.admin.brandColor,
        currency: estimate.admin.currency,
    });
};
