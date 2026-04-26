import ejs from "ejs";
import nodemailer from "nodemailer";
import path from "path";
import AppError from "../errorHelper/AppError";
import status from "http-status";
import { SMTP_EMAIl, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT } from "../config/ENV";

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    secure: true,
    auth: {
        user: SMTP_EMAIl,
        pass: SMTP_PASSWORD,
    },
    port: Number(SMTP_PORT),
    tls: {
        rejectUnauthorized: false, // ← add this
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

        const info = await transporter.sendMail({
            from: SMTP_EMAIl,
            to: to,
            subject: subject,
            html: html,
            attachments: attachments?.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
            })),
        });

        console.log(`Email sent to ${to} : ${info.messageId}`);
    } catch (error: any) {
        console.log("Email Sending Error: ", error);
        throw new AppError(
            status.INTERNAL_SERVER_ERROR,
            "Failed to send email",
        );
    }
};