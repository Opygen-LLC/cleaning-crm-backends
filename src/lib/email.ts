import ejs from "ejs";
import nodemailer from "nodemailer";
import path from "path";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import { SMTP_EMAIL, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_SECURE, SMTP_FROM } from "../config/ENV";
import { prisma } from "./prisma/prisma";
import logger from "./logger";

const portNumber = Number(SMTP_PORT) || 587;
const isSecure = SMTP_SECURE !== undefined ? SMTP_SECURE === "true" : portNumber === 465;

export const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: portNumber,
    secure: isSecure,
    auth: {
        user: SMTP_EMAIL,
        pass: SMTP_PASSWORD,
    },
    tls: {
        rejectUnauthorized: false,
    },
});

interface SendEmailOptions {
    to: string;
    subject: string;
    templateName: string;
    templateData: Record<string, any>;
    adminId?: string;
    attachments?: {
        filename: string;
        content: Buffer | string;
        contentType: string;
    }[];
}

const TEMPLATE_KEY_ALIASES: Record<string, string> = {
    "booking-confirmation": "booking-confirmation",
    "staff-job-dispatch": "staff-assigned",
    "quote-send": "quote-sent",
    "invoice-send": "invoice-due",
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
}: SendEmailOptions) => {
    try {
        const [admin, customTemplate] = adminId
            ? await Promise.all([
                prisma.adminProfile.findUnique({
                    where: { id: adminId },
                    select: { businessName: true, brandColor: true },
                }),
                TEMPLATE_KEY_ALIASES[templateName]
                    ? prisma.notificationTemplate.findUnique({
                        where: {
                            adminId_key: {
                                adminId,
                                key: TEMPLATE_KEY_ALIASES[templateName],
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
        if (customTemplate) {
            const variables = templateVariables(dataWithBrand, admin?.businessName);
            resolvedSubject = replaceVariables(customTemplate.subject || subject, variables, false);
            const escapedBody = escapeHtml(customTemplate.body);
            const body = replaceVariables(escapedBody, variables, true).replace(/\r?\n/g, "<br />");
            html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;color:#111827"><div style="max-width:640px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-top:5px solid ${brandColor};border-radius:12px;padding:32px;line-height:1.65">${body}</div></body></html>`;
        } else {
            const templatePath = path.resolve(
                process.cwd(),
                `src/lib/templates/${templateName}.ejs`,
            );
            html = await ejs.renderFile(templatePath, dataWithBrand);
        }

        const fromAddress = SMTP_FROM || SMTP_EMAIL;

        const info = await transporter.sendMail({
            from: fromAddress,
            to: to,
            subject: resolvedSubject,
            html: html,
            attachments: attachments?.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
            })),
        });

        logger.info(`[SMTP SUCCESS] Email sent to ${to} (Message ID: ${info.messageId})`);
    } catch (error: any) {
        logger.error(
            `[SMTP ERROR] Failed to send email to ${to} (Subject: "${subject}") via ${SMTP_HOST}:${portNumber}:`,
            error?.message || error,
        );
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            `Failed to send email: ${error?.message || "Unknown SMTP error"}`,
        );
    }
};
