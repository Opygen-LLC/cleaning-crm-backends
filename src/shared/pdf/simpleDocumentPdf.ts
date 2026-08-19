/**
 * simpleDocumentPdf.ts
 *
 * A lightweight PDFKit layout shared by Quote and Estimate PDF downloads.
 * Deliberately simpler than Invoice/invoice.pdf.service.ts (single page,
 * no overflow-guard pagination) since quotes/estimates only ever carry a
 * handful of line items. If that stops being true, lift the invoice
 * service's page-overflow guard in here too.
 */

import PDFDocument from "pdfkit";
import { formatMoney } from "../../lib/utils/money";

export interface ISimpleDocLineItem {
    description: string;
    quantity: number;
    unitPrice: number | string;
    total: number | string;
}

export interface ISimpleDocumentPdfParams {
    docTypeLabel: "QUOTE" | "ESTIMATE";
    ref: string;
    status: string;
    issuedOrSentLabel?: string; // e.g. "SENT" date label
    issuedOrSentDate?: Date | null;
    validUntil: Date;
    clientName: string;
    clientEmail?: string | null;
    address: string;
    lineItems: ISimpleDocLineItem[];
    subtotal: number | string;
    taxRate: number | string;
    taxAmount: number | string;
    total: number | string;
    notes?: string | null;
    businessName?: string;
    businessEmail?: string | null;
    brandColor?: string | null;
    currency: string;
}

const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

const COLORS = {
    headerBg: "#0F172A",
    primary: "#1F2937",
    muted: "#6B7280",
    light: "#9CA3AF",
    border: "#E2E8F0",
    accent: "#0F172A",
    accentText: "#FFFFFF",
};

export const generateSimpleDocumentPDFBuffer = (
    params: ISimpleDocumentPdfParams,
): Promise<Buffer> => {
    const brandColor = /^#[0-9a-f]{6}$/i.test(params.brandColor ?? "")
        ? params.brandColor!
        : COLORS.headerBg;
    const businessName = params.businessName || "CleanCRM";
    const fmt2dp = (n: unknown) => formatMoney(Number(n), params.currency);
    return new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            info: {
                Title: `${params.docTypeLabel === "QUOTE" ? "Quote" : "Estimate"} ${params.ref}`,
                Author: businessName,
                Subject: `${params.docTypeLabel} for ${params.clientName}`,
                Creator: "CleanCRM PDF Service",
            },
        });

        const chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const W = doc.page.width;
        const MARGIN = 48;
        const CONTENT = W - MARGIN * 2;

        // ── Header band ──────────────────────────────────────────────────────
        doc.rect(0, 0, W, 100).fill(brandColor);
        doc.font("Helvetica-Bold").fontSize(20).fillColor("#FFFFFF").text(businessName, MARGIN, 28);
        doc.font("Helvetica").fontSize(9).fillColor("#94A3B8").text("PROFESSIONAL CLEANING SERVICES", MARGIN, 53);
        doc.font("Helvetica-Bold").fontSize(16).fillColor("#FFFFFF").text(params.ref, 0, 28, {
            align: "right",
            width: W - MARGIN,
        });
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#94A3B8").text(
            `${params.docTypeLabel} · ${params.status.toUpperCase()}`,
            0,
            54,
            { align: "right", width: W - MARGIN },
        );

        // ── Meta strip ───────────────────────────────────────────────────────
        const STRIP_Y = 110;
        doc.rect(0, 100, W, 58).fill("#F8FAFC");
        doc.rect(0, 158, W, 1).fill(COLORS.border);

        const metaItems: Array<{ label: string; value: string }> = [
            ...(params.issuedOrSentDate
                ? [{ label: params.issuedOrSentLabel ?? "ISSUED", value: fmtDate(params.issuedOrSentDate) }]
                : []),
            { label: "VALID UNTIL", value: fmtDate(params.validUntil) },
            { label: "ADDRESS", value: params.address },
        ];
        const colW = CONTENT / Math.max(metaItems.length, 1);
        metaItems.forEach((item, i) => {
            const x = MARGIN + i * colW;
            doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.light).text(item.label, x, STRIP_Y, { width: colW - 8 });
            doc.font("Helvetica").fontSize(11).fillColor(COLORS.primary).text(item.value, x, STRIP_Y + 12, { width: colW - 8 });
        });

        // ── Client box ───────────────────────────────────────────────────────
        const BODY_Y = 175;
        doc.rect(MARGIN, BODY_Y, CONTENT, 60).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.light).text("PREPARED FOR", MARGIN + 12, BODY_Y + 10);
        doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.primary).text(params.clientName, MARGIN + 12, BODY_Y + 22);
        if (params.clientEmail) {
            doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted).text(params.clientEmail, MARGIN + 12, BODY_Y + 38);
        }

        // ── Line items table ─────────────────────────────────────────────────
        const TABLE_Y = BODY_Y + 76;
        const COL = {
            desc: MARGIN,
            qty: MARGIN + CONTENT * 0.55,
            price: MARGIN + CONTENT * 0.7,
            total: MARGIN + CONTENT * 0.85,
        };

        doc.rect(MARGIN, TABLE_Y, CONTENT, 28).fill(brandColor);
        [
            { text: "DESCRIPTION", x: COL.desc + 8 },
            { text: "QTY", x: COL.qty + 8 },
            { text: "UNIT PRICE", x: COL.price + 8 },
            { text: "AMOUNT", x: COL.total + 8 },
        ].forEach(({ text, x }) => {
            doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#94A3B8").text(text, x, TABLE_Y + 10, { width: 90 });
        });

        let rowY = TABLE_Y + 28;
        params.lineItems.forEach((item, i) => {
            const rowH = 34;
            if (i % 2 === 1) doc.rect(MARGIN, rowY, CONTENT, rowH).fill("#FAFAFA");
            doc.rect(MARGIN, rowY + rowH - 0.5, CONTENT, 0.5).fill(COLORS.border);

            doc.font("Helvetica").fontSize(11).fillColor(COLORS.primary)
                .text(item.description, COL.desc + 8, rowY + 11, { width: COL.qty - COL.desc - 16 });
            doc.font("Helvetica").fontSize(11).fillColor(COLORS.muted)
                .text(String(item.quantity), COL.qty + 8, rowY + 11, { width: 60 });
            doc.font("Helvetica").fontSize(11).fillColor(COLORS.muted)
                .text(fmt2dp(item.unitPrice), COL.price + 8, rowY + 11, { width: 80 });
            doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.primary)
                .text(fmt2dp(item.total), COL.total + 8, rowY + 11, { width: 80 });

            rowY += rowH;
        });

        // ── Totals ───────────────────────────────────────────────────────────
        const TOT_X = MARGIN + CONTENT * 0.55;
        const TOT_W = CONTENT * 0.45;
        let totY = rowY + 12;

        const drawTotalRow = (label: string, value: string, bold = false) => {
            doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor(COLORS.muted)
                .text(label, TOT_X, totY, { width: TOT_W * 0.6 });
            doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(11).fillColor(bold ? COLORS.primary : COLORS.muted)
                .text(value, TOT_X + TOT_W * 0.6, totY, { width: TOT_W * 0.4, align: "right" });
            doc.rect(TOT_X, totY + 16, TOT_W, 0.5).fill(COLORS.border);
            totY += 24;
        };

        drawTotalRow("Subtotal", fmt2dp(params.subtotal));
        if (Number(params.taxRate) > 0) {
            drawTotalRow(`VAT (${Number(params.taxRate)}%)`, fmt2dp(params.taxAmount));
        }

        totY += 4;
        doc.rect(TOT_X, totY, TOT_W, 38).fill(brandColor);
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#94A3B8")
            .text(params.docTypeLabel === "QUOTE" ? "TOTAL" : "ESTIMATED TOTAL", TOT_X + 12, totY + 13, { width: TOT_W * 0.5 });
        doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.accentText)
            .text(fmt2dp(params.total), TOT_X, totY + 9, { align: "right", width: TOT_W - 12 });
        totY += 50;

        // ── Notes ────────────────────────────────────────────────────────────
        if (params.notes) {
            totY += 8;
            doc.rect(MARGIN, totY, CONTENT, 1).fill(COLORS.border);
            totY += 12;
            doc.font("Helvetica-Bold").fontSize(8).fillColor("#92400E").text("NOTES", MARGIN, totY);
            totY += 12;
            doc.font("Helvetica").fontSize(10).fillColor("#78350F").text(params.notes, MARGIN, totY, { width: CONTENT });
        }

        // ── Footer ───────────────────────────────────────────────────────────
        const FOOTER_Y = doc.page.height - 57;
        doc.rect(0, FOOTER_Y - 1, W, 1).fill(COLORS.border);
        doc.rect(0, FOOTER_Y, W, 57).fill("#F8FAFC");
        doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.primary)
            .text(
                params.docTypeLabel === "QUOTE"
                    ? "This quote is valid until the date above."
                    : "This estimate is indicative and may change after a site visit.",
                MARGIN,
                FOOTER_Y + 14,
            );
        doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted).text(`Questions? ${params.businessEmail ?? "Contact us"}`, MARGIN, FOOTER_Y + 30);
        doc.font("Helvetica").fontSize(9).fillColor(COLORS.light).text(params.ref, 0, FOOTER_Y + 22, {
            align: "right",
            width: W - MARGIN,
        });

        doc.end();
    });
};
