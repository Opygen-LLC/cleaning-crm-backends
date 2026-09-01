import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { generateSimpleDocumentPDFBuffer } from "../../shared/pdf/simpleDocumentPdf";

export const generateQuotePDFBuffer = async (quoteId: string): Promise<Buffer> => {
    const quote = await prisma.quote.findUnique({
        where: { id: quoteId },
        include: {
            client: true,
            lineItems: true,
            admin: { select: { businessName: true, businessEmail: true, brandColor: true, currency: true } },
        },
    });

    if (!quote) {
        throw new AppError(status.NOT_FOUND, "Quote not found");
    }

    return generateSimpleDocumentPDFBuffer({
        docTypeLabel: "QUOTE",
        ref: quote.quoteRef,
        status: quote.status,
        issuedOrSentLabel: quote.sentAt ? "SENT" : quote.publishedAt ? "PUBLISHED" : "ISSUED",
        issuedOrSentDate: quote.sentAt ?? quote.publishedAt ?? quote.createdAt,
        validUntil: quote.validUntil,
        clientName: quote.client.name,
        clientEmail: quote.client.email,
        address: quote.address,
        lineItems: quote.lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice.toString(),
            total: li.total.toString(),
        })),
        subtotal: quote.subtotal.toString(),
        taxRate: quote.taxRate.toString(),
        taxAmount: quote.tax.toString(),
        total: quote.total.toString(),
        notes: quote.notes,
        businessName: quote.admin.businessName,
        businessEmail: quote.admin.businessEmail,
        brandColor: quote.admin.brandColor,
        currency: quote.admin.currency,
    });
};
