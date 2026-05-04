import chalk from "chalk";
import { sendEmail } from "../email";

export const sendEmailSafely = async (
    options: Parameters<typeof sendEmail>[0],
) => {
    return await sendEmail(options).catch((err) => {
        console.error(
            chalk.red(
                `[EMAIL ERROR] Failed to send "${options.subject}" to ${options.to}`,
            ),
            err,
        );
    });
};
