import cron from "node-cron";
import { AccountStatus, InvoiceStatus, TenantLifecycleStatus } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import { queueInvoiceNotification } from "../lib/notifications/businessNotificationEvents";
import { fail, log } from "./index.cron";
import { TenantAccessResolver } from "../modules/Entitlement/tenantAccessResolver.service";

export const runInvoiceOverdueJob = async () => {
    const now = new Date();
    const due = await prisma.invoice.findMany({
        where: { status: InvoiceStatus.SENT, dueDate: { lt: now }, admin: { lifecycleStatus: TenantLifecycleStatus.ACTIVE, user: { status: AccountStatus.ACTIVE } } },
        select: { id: true, adminId: true, dueDate: true },
        take: 1_000,
    });

    if (!due.length) return { marked: 0, queued: 0 };

    const accessByTenant = new Map<string, boolean>();
    const eligible: typeof due = [];
    for (const invoice of due) {
        let allowed = accessByTenant.get(invoice.adminId);
        if (allowed === undefined) {
            allowed = (await TenantAccessResolver.resolve(invoice.adminId)).access.backgroundJobsAllowed;
            accessByTenant.set(invoice.adminId, allowed);
        }
        if (allowed) eligible.push(invoice);
    }
    if (!eligible.length) return { marked: 0, queued: 0 };

    const ids = eligible.map((invoice) => invoice.id);
    const result = await prisma.invoice.updateMany({
        where: { id: { in: ids }, status: InvoiceStatus.SENT },
        data: { status: InvoiceStatus.OVERDUE },
    });

    let queued = 0;
    for (const invoice of eligible) {
        const outcome = await queueInvoiceNotification(
            invoice.id,
            "invoice-due",
            invoice.dueDate.toISOString(),
        );
        if (outcome.queued) queued += 1;
    }

    return { marked: result.count, queued };
};

// Daily overdue state transition + durable due-reminder enqueue. SMTP is never
// called from the scheduler; the worker owns all delivery/retry behaviour.
if (process.env.NODE_ENV !== "test") {
    cron.schedule("0 0 * * *", async () => {
        try {
            log("Running invoice overdue check...");
            const result = await runInvoiceOverdueJob();
            if (!result.marked) log("No invoices to mark overdue — all up to date");
            else log(`Marked ${result.marked} invoice(s) as OVERDUE; queued ${result.queued} due reminder(s)`);
        } catch (err) {
            fail("invoiceOverdueCheck", err);
        }
    });
}
