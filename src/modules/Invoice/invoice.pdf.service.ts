import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LineItem {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt2dp = (n: unknown) => `£${Number(n).toFixed(2)}`;
const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });

// ─── Color palette (matches the HTML template in InvoiceDetailPage) ───────────

const COLORS = {
    headerBg: "#0F172A",
    primary: "#1F2937",
    muted: "#6B7280",
    light: "#9CA3AF",
    border: "#E2E8F0",
    accent: "#0F172A",
    accentText: "#FFFFFF",
    statusPaid: "#059669",
    statusOver: "#E11D48",
    statusSent: "#2563EB",
    statusDraft: "#6B7280",
    statusCan: "#7C3AED",
};

function statusColor(invoiceStatus: string): string {
    const map: Record<string, string> = {
        PAID: COLORS.statusPaid,
        SENT: COLORS.statusSent,
        OVERDUE: COLORS.statusOver,
        DRAFT: COLORS.statusDraft,
        CANCELLED: COLORS.statusCan,
    };
    return map[invoiceStatus.toUpperCase()] ?? COLORS.statusDraft;
}

// ─── Layout constants ─────────────────────────────────────────────────────────

// Heights in points used for the page-overflow guard (section 4→5).
// Keeping them here makes the guard readable without magic numbers.
const FOOTER_BAND_H = 57; // footer separator (1pt) + band (56pt)
const TOTALS_BLOCK_H = 140; // subtotal row (24) + optional VAT row (24) + gap (4) + grand-total (38) + padding (50)
const NOTES_FALLBACK = 80; // conservative reserve when notes are present but not yet measured

// ─── Main PDF builder ─────────────────────────────────────────────────────────

export const generateInvoicePDFBuffer = async (
    invoiceId: string,
): Promise<{ buffer: Buffer; invoiceRef: string }> => {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            serviceCatalog: { select: { serviceName: true } },
            admin: {
                select: {
                    businessName: true,
                    businessEmail: true,
                    brandColor: true,
                },
            },
        },
    });

    if (!invoice) {
        throw new AppError(status.NOT_FOUND, "Invoice not found");
    }

    const lineItems: LineItem[] = Array.isArray(invoice.lineItems)
        ? (invoice.lineItems as unknown as LineItem[])
        : [];
    const brandColor = /^#[0-9a-f]{6}$/i.test(invoice.admin.brandColor ?? "")
        ? invoice.admin.brandColor!
        : COLORS.headerBg;

    return new Promise<{ buffer: Buffer; invoiceRef: string }>((resolve, reject) => {
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            // bufferPages: true keeps all pages in memory so we could post-process
            // them if needed. Omitted here — we only need a linear stream.
            info: {
                Title: `Invoice ${invoice.invoiceRef}`,
                Author: invoice.admin.businessName,
                Subject: `Invoice for ${invoice.clientName}`,
                Creator: "CleanCRM PDF Service",
            },
        });

        const chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve({ buffer: Buffer.concat(chunks), invoiceRef: invoice.invoiceRef }));
        doc.on("error", reject);

        const W = doc.page.width; // 595.28 pt  (A4)
        const PAGE_H = doc.page.height; // 841.89 pt
        const MARGIN = 48;
        const CONTENT = W - MARGIN * 2;

        // ── 1. Header band ────────────────────────────────────────────────────
        doc.rect(0, 0, W, 100).fill(brandColor);

        doc.font("Helvetica-Bold")
            .fontSize(20)
            .fillColor("#FFFFFF")
            .text(invoice.admin.businessName, MARGIN, 28);

        doc.font("Helvetica")
            .fontSize(9)
            .fillColor("#94A3B8")
            .text("PROFESSIONAL CLEANING SERVICES", MARGIN, 53);

        doc.font("Helvetica-Bold")
            .fontSize(16)
            .fillColor("#FFFFFF")
            .text(invoice.invoiceRef, 0, 28, {
                align: "right",
                width: W - MARGIN,
            });

        const sc = statusColor(invoice.status);
        doc.font("Helvetica-Bold")
            .fontSize(8)
            .fillColor(sc)
            .text(invoice.status.toUpperCase(), 0, 54, {
                align: "right",
                width: W - MARGIN,
            });

        // ── 2. Meta strip ──────────────────────────────────────────────────────
        const STRIP_Y = 110;
        doc.rect(0, 100, W, 58).fill("#F8FAFC");
        doc.rect(0, 158, W, 1).fill(COLORS.border);

        const metaItems: Array<{
            label: string;
            value: string;
            color?: string;
        }> = [
            { label: "ISSUE DATE", value: fmtDate(invoice.issuedDate) },
            {
                label: "DUE DATE",
                value: fmtDate(invoice.dueDate),
                color:
                    invoice.status === "OVERDUE"
                        ? COLORS.statusOver
                        : undefined,
            },
            ...(invoice.paidDate
                ? [
                      {
                          label: "PAID ON",
                          value: fmtDate(invoice.paidDate),
                          color: COLORS.statusPaid,
                      },
                  ]
                : []),
            ...(invoice.linkedBookingRef
                ? [{ label: "BOOKING REF", value: invoice.linkedBookingRef }]
                : []),
            ...(invoice.serviceCatalog
                ? [
                      {
                          label: "SERVICE",
                          value: invoice.serviceCatalog.serviceName,
                      },
                  ]
                : []),
        ];

        const colW = CONTENT / Math.max(metaItems.length, 1);
        metaItems.forEach((item, i) => {
            const x = MARGIN + i * colW;
            doc.font("Helvetica-Bold")
                .fontSize(7.5)
                .fillColor(COLORS.light)
                .text(item.label, x, STRIP_Y, { width: colW - 8 });
            doc.font("Helvetica")
                .fontSize(11)
                .fillColor(item.color ?? COLORS.primary)
                .text(item.value, x, STRIP_Y + 12, { width: colW - 8 });
        });

        // ── 3. Bill-to / From grid ─────────────────────────────────────────────
        const BODY_Y = 175;

        const drawPartyBox = (
            x: number,
            y: number,
            w: number,
            label: string,
            name: string,
            lines: string[],
        ) => {
            doc.rect(x, y, w, 80)
                .strokeColor(COLORS.border)
                .lineWidth(0.5)
                .stroke();

            doc.font("Helvetica-Bold")
                .fontSize(7.5)
                .fillColor(COLORS.light)
                .text(label, x + 12, y + 10, { width: w - 24 });

            doc.font("Helvetica-Bold")
                .fontSize(12)
                .fillColor(COLORS.primary)
                .text(name, x + 12, y + 22, { width: w - 24 });

            doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted);

            let lineY = y + 38;
            lines.forEach((line) => {
                if (!line) return;
                doc.text(line, x + 12, lineY, { width: w - 24 });
                lineY += 13;
            });
        };

        const halfW = (CONTENT - 16) / 2;
        drawPartyBox(MARGIN, BODY_Y, halfW, "BILL TO", invoice.clientName, [
            invoice.clientEmail,
            invoice.serviceAddress ?? "",
        ]);
        drawPartyBox(
            MARGIN + halfW + 16,
            BODY_Y,
            halfW,
            "FROM",
            invoice.admin.businessName,
            ["Professional Cleaning Services", invoice.admin.businessEmail ?? ""],
        );

        // ── 4. Line-items table ────────────────────────────────────────────────
        const TABLE_Y = BODY_Y + 96;
        const COL = {
            desc: MARGIN,
            qty: MARGIN + CONTENT * 0.55,
            price: MARGIN + CONTENT * 0.7,
            total: MARGIN + CONTENT * 0.85,
        };

        doc.rect(MARGIN, TABLE_Y, CONTENT, 28).fill(brandColor);
        const headers = [
            { text: "DESCRIPTION", x: COL.desc + 8 },
            { text: "QTY", x: COL.qty + 8 },
            { text: "UNIT PRICE", x: COL.price + 8 },
            { text: "AMOUNT", x: COL.total + 8 },
        ];
        headers.forEach(({ text, x }) => {
            doc.font("Helvetica-Bold")
                .fontSize(7.5)
                .fillColor("#94A3B8")
                .text(text, x, TABLE_Y + 10, { width: 90 });
        });

        let rowY = TABLE_Y + 28;
        lineItems.forEach((item, i) => {
            const rowH = 34;
            if (i % 2 === 1) {
                doc.rect(MARGIN, rowY, CONTENT, rowH).fill("#FAFAFA");
            }
            doc.rect(MARGIN, rowY + rowH - 0.5, CONTENT, 0.5).fill(
                COLORS.border,
            );

            doc.font("Helvetica")
                .fontSize(11)
                .fillColor(COLORS.primary)
                .text(item.description, COL.desc + 8, rowY + 11, {
                    width: COL.qty - COL.desc - 16,
                });

            doc.font("Helvetica")
                .fontSize(11)
                .fillColor(COLORS.muted)
                .text(String(item.quantity), COL.qty + 8, rowY + 11, {
                    width: 60,
                });

            doc.font("Helvetica")
                .fontSize(11)
                .fillColor(COLORS.muted)
                .text(fmt2dp(item.unitPrice), COL.price + 8, rowY + 11, {
                    width: 80,
                });

            doc.font("Helvetica-Bold")
                .fontSize(11)
                .fillColor(COLORS.primary)
                .text(fmt2dp(item.total), COL.total + 8, rowY + 11, {
                    width: 80,
                });

            rowY += rowH;
        });

        // ── PAGE OVERFLOW GUARD ───────────────────────────────────────────────
        //
        // Problem: on invoices with many line items, `rowY` can exceed the page
        // height.  Without this guard, the totals block and footer land on top of
        // each other on page 2 while page 1 has a gap, producing a broken layout.
        //
        // Fix: measure the space still needed (totals + notes + footer band) and
        // add a fresh page when the remaining vertical room is insufficient.
        // All subsequent drawing (totals, notes, footer) uses `currentPageH` so
        // FOOTER_Y is always relative to the page the content actually lands on.
        //
        // Max safe rows on a single page ≈ 8 items.
        // Invoices with ≥ 9 line items will render cleanly across two pages.
        // ─────────────────────────────────────────────────────────────────────

        const notesHeight = invoice.notes
            ? Math.max(
                  doc.heightOfString(invoice.notes, { width: CONTENT }) + 48,
                  NOTES_FALLBACK,
              )
            : 0;

        const spaceNeeded = TOTALS_BLOCK_H + notesHeight + FOOTER_BAND_H;
        const spaceLeft = PAGE_H - rowY;

        let currentPageH = PAGE_H;

        if (spaceLeft < spaceNeeded) {
            doc.addPage({
                size: "A4",
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
            });
            currentPageH = doc.page.height;
            rowY = MARGIN;
        }

        // ── 5. Totals block ────────────────────────────────────────────────────
        const TOT_X = MARGIN + CONTENT * 0.55;
        const TOT_W = CONTENT * 0.45;
        let totY = rowY + 12;

        const drawTotalRow = (label: string, value: string, bold = false) => {
            doc.font(bold ? "Helvetica-Bold" : "Helvetica")
                .fontSize(11)
                .fillColor(COLORS.muted)
                .text(label, TOT_X, totY, { width: TOT_W * 0.6 });
            doc.font(bold ? "Helvetica-Bold" : "Helvetica")
                .fontSize(11)
                .fillColor(bold ? COLORS.primary : COLORS.muted)
                .text(value, TOT_X + TOT_W * 0.6, totY, {
                    width: TOT_W * 0.4,
                    align: "right",
                });
            doc.rect(TOT_X, totY + 16, TOT_W, 0.5).fill(COLORS.border);
            totY += 24;
        };

        drawTotalRow("Subtotal", fmt2dp(invoice.subtotal));
        if (Number(invoice.taxRate) > 0) {
            drawTotalRow(
                `VAT (${Number(invoice.taxRate)}%)`,
                fmt2dp(invoice.taxAmount),
            );
        }

        totY += 4;
        doc.rect(TOT_X, totY, TOT_W, 38).fill(brandColor);
        doc.font("Helvetica-Bold")
            .fontSize(11)
            .fillColor("#94A3B8")
            .text("TOTAL DUE", TOT_X + 12, totY + 13, { width: TOT_W * 0.5 });
        doc.font("Helvetica-Bold")
            .fontSize(18)
            .fillColor(COLORS.accentText)
            .text(fmt2dp(invoice.total), TOT_X, totY + 9, {
                align: "right",
                width: TOT_W - 12,
            });
        totY += 50;

        // ── 6. Notes (optional) ───────────────────────────────────────────────
        if (invoice.notes) {
            totY += 8;
            doc.rect(MARGIN, totY, CONTENT, 1).fill(COLORS.border);
            totY += 12;
            doc.font("Helvetica-Bold")
                .fontSize(8)
                .fillColor("#92400E")
                .text("NOTES", MARGIN, totY);
            totY += 12;
            doc.font("Helvetica")
                .fontSize(10)
                .fillColor("#78350F")
                .text(invoice.notes, MARGIN, totY, { width: CONTENT });
            // totY not used further; kept for symmetry if blocks are added later.
        }

        // ── 7. Footer ──────────────────────────────────────────────────────────
        // Use `currentPageH` (set by the overflow guard above) so the footer
        // is always anchored to the bottom of whichever page the content lands on.
        const FOOTER_Y = currentPageH - FOOTER_BAND_H;
        doc.rect(0, FOOTER_Y - 1, W, 1).fill(COLORS.border);
        doc.rect(0, FOOTER_Y, W, FOOTER_BAND_H).fill("#F8FAFC");

        doc.font("Helvetica-Bold")
            .fontSize(11)
            .fillColor(COLORS.primary)
            .text("Thank you for your business.", MARGIN, FOOTER_Y + 14);
        doc.font("Helvetica")
            .fontSize(9)
            .fillColor(COLORS.muted)
            .text(`Questions? ${invoice.admin.businessEmail ?? invoice.clientEmail}`, MARGIN, FOOTER_Y + 30);

        doc.font("Helvetica")
            .fontSize(9)
            .fillColor(COLORS.light)
            .text(invoice.invoiceRef, 0, FOOTER_Y + 22, {
                align: "right",
                width: W - MARGIN,
            });

        doc.end();
    });
};
