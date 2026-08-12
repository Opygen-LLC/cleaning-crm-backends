import { sendEmail } from "../email";
import logger from "../logger";

export const sendEmailSafely = async (
    options: Parameters<typeof sendEmail>[0],
) => {
    return await sendEmail(options).catch((err) => {
        logger.error(
            `[EMAIL ERROR] Failed to send "${options.subject}" to ${options.to}`,
            err,
        );
    });
};
