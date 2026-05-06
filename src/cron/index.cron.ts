import chalk from "chalk";

export const log = (msg: string) => console.log(chalk.green(`[CRON] ${msg}`));

export const fail = (job: string, err: unknown) =>
    console.error(chalk.red(`[CRON][${job}] Failed:`, err));
