import ejs from "ejs";
import nodemailer from "nodemailer";
import path from "path";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import { SMTP_EMAIL, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_SECURE, SMTP_FROM } from "../config/ENV";

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
    attachments?: {
        filename: string;
        content: Buffer | string;
        contentType: string;
    }[];
}

export const sendEmail = async ({
    subject,
    templateData,
    templateName,
    to,
    attachments,
}: SendEmailOptions) => {
    try {
        const templatePath = path.resolve(
            process.cwd(),
            `src/lib/templates/${templateName}.ejs`,
        );
        const html = await ejs.renderFile(templatePath, templateData);

        const fromAddress = SMTP_FROM || SMTP_EMAIL;

        const info = await transporter.sendMail({
            from: fromAddress,
            to: to,
            subject: subject,
            html: html,
            attachments: attachments?.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
            })),
        });

        console.log(`[SMTP SUCCESS] Email sent to ${to} (Message ID: ${info.messageId})`);
    } catch (error: any) {
        console.error(
            `[SMTP ERROR] Failed to send email to ${to} (Subject: "${subject}") via ${SMTP_HOST}:${portNumber}:`,
            error?.message || error
        );
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            `Failed to send email: ${error?.message || "Unknown SMTP error"}`,
        );
    }
};