import cron from "node-cron";
import { InvoiceStatus } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import { fail, log } from "./index.cron";

// ─── Cron: runs daily at midnight UTC ─────────────────────────────────────────
// Finds all SENT invoices whose dueDate has passed and marks them OVERDUE.

cron.schedule("0 0 * * *", async () => {
    try {
        log("Running invoice overdue check...");

        const now = new Date();

        const result = await prisma.invoice.updateMany({
            where: {
                status:  InvoiceStatus.SENT,
                dueDate: { lt: now },
            },
            data: { status: InvoiceStatus.OVERDUE },
        });

        if (result.count === 0) {
            log("No invoices to mark overdue — all up to date");
        } else {
            log(`Marked ${result.count} invoice(s) as OVERDUE`);
        }
    } catch (err) {
        fail("invoiceOverdueCheck", err);
    }
});
