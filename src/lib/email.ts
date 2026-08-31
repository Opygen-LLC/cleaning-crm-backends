import ejs from "ejs";
import nodemailer from "nodemailer";
import path from "path";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import {
    SMTP_EMAIL,
    SMTP_FROM,
    SMTP_FROM_NAME,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_SECURE,
} from "../config/ENV";
import { prisma } from "./prisma/prisma";
import logger from "./logger";
import {
    BUSINESS_NOTIFICATION_REGISTRY,
    isBusinessNotificationTemplateKey,
    type BusinessNotificationTemplateKey,
} from "./notifications/businessNotificationRegistry";

const portNumber = Number(SMTP_PORT) || 587;
const configuredSecure = SMTP_SECURE !== undefined ? SMTP_SECURE === "true" : portNumber === 465;
// SMTP submission port 587 uses STARTTLS (`secure: false` in Nodemailer),
// while port 465 uses implicit TLS. Normalize the two standard ports so a
// stale SMTP_SECURE env value cannot silently break OTP delivery. Custom ports
// continue to honor the explicit SMTP_SECURE setting.
const isSecure = portNumber === 465 ? true : portNumber === 587 ? false : configuredSecure;
const normalizedHost = (SMTP_HOST || "").trim().toLowerCase();

// Google displays app passwords in groups separated by spaces. The actual
// credential is the 16-character value without those display spaces. Only
// normalize whitespace for Gmail so passwords for other SMTP providers retain
// their exact value.
const smtpPassword = normalizedHost === "smtp.gmail.com"
    ? (SMTP_PASSWORD || "").replace(/\s+/g, "")
    : (SMTP_PASSWORD || "");

const smtpUser = (SMTP_EMAIL || "").trim();
const fromAddress = (SMTP_FROM || smtpUser).trim();

const assertSmtpConfiguration = () => {
    const missing: string[] = [];
    if (!normalizedHost) missing.push("SMTP_HOST");
    if (!smtpUser) missing.push("SMTP_EMAIL");
    if (!smtpPassword) missing.push("SMTP_PASSWORD");
    if (!Number.isFinite(portNumber) || portNumber <= 0) missing.push("SMTP_PORT");

    if (missing.length > 0) {
        throw new Error(`Email delivery is not configured. Missing: ${missing.join(", ")}.`);
    }
};

const maskEmail = (value: string) => {
    const [local, domain] = value.split("@");
    if (!local || !domain) return "configured mailbox";
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${local.length > 2 ? "***" : "*"}@${domain}`;
};

const readableSmtpError = (error: unknown) => {
    const value = error as { code?: string; responseCode?: number; message?: string } | undefined;
    const code = String(value?.code ?? "").toUpperCase();
    const responseCode = Number(value?.responseCode ?? 0);
    const raw = String(value?.message ?? "Unknown SMTP error");

    if (code === "EAUTH" || responseCode === 535 || /invalid login|authentication/i.test(raw)) {
        return "SMTP authentication failed. Check SMTP_EMAIL and SMTP_PASSWORD. For Gmail, use a Google App Password, not the normal account password.";
    }
    if (["ECONNREFUSED", "ETIMEDOUT", "ESOCKET", "ENOTFOUND"].includes(code)) {
        return `Unable to connect to the configured SMTP server (${SMTP_HOST}:${portNumber}). Check the host, port, firewall and network access.`;
    }
    if (responseCode >= 550 && responseCode < 560) {
        return "The mail server rejected the message. Check the sender address and recipient mailbox.";
    }
    return raw;
};

export const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: portNumber,
    secure: isSecure,
    auth: {
        user: smtpUser,
        pass: smtpPassword,
    },
    tls: {
        minVersion: "TLSv1.2",
    },
});

export const verifyEmailTransport = async () => {
    assertSmtpConfiguration();
    if (SMTP_SECURE !== undefined && configuredSecure !== isSecure) {
        logger.warn(
            `SMTP_SECURE=${SMTP_SECURE} is incompatible with standard submission port ${portNumber}; using secure=${String(isSecure)}.`,
        );
    }
    try {
        await transporter.verify();
        logger.info(
            `Email service ready — ${SMTP_HOST}:${portNumber} as ${maskEmail(smtpUser)}.`,
        );
    } catch (error) {
        const message = readableSmtpError(error);
        logger.error(`Email service unavailable — ${message}`);
        throw new Error(message);
    }
};

interface SendEmailOptions {
    to: string;
    subject: string;
    templateName: string;
    templateData: Record<string, any>;
    adminId?: string;
    useBusinessTemplate?: boolean;
    messageId?: string;
    attachments?: {
        filename: string;
        content: Buffer | string;
        contentType: string;
    }[];
}

const TEMPLATE_KEY_ALIASES: Record<string, BusinessNotificationTemplateKey> = {
    "booking-confirmation": "booking-confirmation",
    "booking-reminder-24h": "booking-reminder-24h",
    "booking-reminder-day-of": "booking-reminder-day-of",
    "staff-job-dispatch": "staff-assigned",
    "staff-assigned": "staff-assigned",
    "quote-send": "quote-sent",
    "quote-sent": "quote-sent",
    "invoice-send": "invoice-sent",
    "invoice-sent": "invoice-sent",
    "invoice-due": "invoice-due",
    "review-request": "review-request",
};

const escapeHtml = (value: unknown) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const toSnakeCase = (key: string) => key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

const templateVariables = (
    templateData: Record<string, any>,
    businessName?: string | null,
) => {
    const variables: Record<string, string> = {};
    Object.entries(templateData).forEach(([key, value]) => {
        if (["string", "number"].includes(typeof value)) {
            variables[toSnakeCase(key)] = String(value);
        }
    });
    return {
        ...variables,
        client_name: String(templateData.clientName ?? ""),
        booking_date: String(templateData.scheduledDate ?? templateData.bookingDate ?? ""),
        booking_time: String(templateData.scheduledTime ?? templateData.bookingTime ?? ""),
        service_type: String(templateData.serviceType ?? ""),
        staff_name: String(templateData.staffName ?? ""),
        address: String(templateData.address ?? templateData.serviceAddress ?? ""),
        invoice_amount: String(templateData.total ?? templateData.invoiceAmount ?? ""),
        due_date: String(templateData.dueDate ?? ""),
        review_link: String(templateData.reviewUrl ?? ""),
        business_name: String(businessName ?? templateData.businessName ?? ""),
    };
};

const replaceVariables = (
    text: string,
    variables: Record<string, string>,
    escapeValues: boolean,
) => text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key] ?? `{{${key}}}`;
    return escapeValues ? escapeHtml(value) : value;
});

export const sendEmail = async ({
    subject,
    templateData,
    templateName,
    to,
    attachments,
    adminId,
    useBusinessTemplate = true,
    messageId,
}: SendEmailOptions) => {
    assertSmtpConfiguration();

    try {
        const canonicalKey = useBusinessTemplate
            ? (TEMPLATE_KEY_ALIASES[templateName]
                ?? (isBusinessNotificationTemplateKey(templateName) ? templateName : null))
            : null;
        const [admin, customTemplate] = adminId
            ? await Promise.all([
                prisma.adminProfile.findUnique({
                    where: { id: adminId },
                    select: { businessName: true, brandColor: true },
                }),
                canonicalKey
                    ? prisma.notificationTemplate.findUnique({
                        where: {
                            adminId_key: {
                                adminId,
                                key: canonicalKey,
                            },
                        },
                    })
                    : Promise.resolve(null),
            ])
            : [null, null];

        const brandColor = /^#[0-9a-f]{6}$/i.test(admin?.brandColor ?? "")
            ? admin!.brandColor!
            : "#111827";
        const dataWithBrand = {
            ...templateData,
            businessName: admin?.businessName ?? templateData.businessName,
            brandColor,
        };

        let resolvedSubject = subject;
        let html: string;
        if (canonicalKey) {
            const definition = BUSINESS_NOTIFICATION_REGISTRY[canonicalKey];
            const variables = templateVariables(dataWithBrand, admin?.businessName);
            const subjectTemplate = customTemplate?.subject || definition.defaultSubject || subject;
            const bodyTemplate = customTemplate?.body || definition.defaultBody;
            resolvedSubject = replaceVariables(subjectTemplate, variables, false);
            const escapedBody = escapeHtml(bodyTemplate);
            const body = replaceVariables(escapedBody, variables, true).replace(/\r?\n/g, "<br />");
            html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;color:#111827"><div style="max-width:640px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-top:5px solid ${brandColor};border-radius:12px;padding:32px;line-height:1.65">${body}</div></body></html>`;
        } else {
            const templatePath = path.resolve(
                process.cwd(),
                `src/lib/templates/${templateName}.ejs`,
            );
            html = await ejs.renderFile(templatePath, dataWithBrand);
        }

        await transporter.sendMail({
            from: {
                name: SMTP_FROM_NAME,
                address: fromAddress,
            },
            to,
            subject: resolvedSubject,
            messageId,
            html,
            attachments: attachments?.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
            })),
        });

        logger.info(`Email sent — ${resolvedSubject} → ${maskEmail(to)}.`);
    } catch (error) {
        const message = readableSmtpError(error);
        logger.error(`Email delivery failed — ${message}`);
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Email delivery is temporarily unavailable. Please try again shortly.",
            {
                code: "EMAIL_DELIVERY_UNAVAILABLE",
                retryable: true,
            },
        );
    }
};
