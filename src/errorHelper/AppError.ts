import { TFieldErrors } from "../interface/error.interface";

export interface AppErrorOptions {
    code?: string;
    retryable?: boolean;
    fieldErrors?: TFieldErrors;
    stack?: string;
}

class AppError extends Error {
    public statusCode: number;
    public code?: string;
    public retryable?: boolean;
    public fieldErrors?: TFieldErrors;

    constructor(
        statusCode: number,
        message: string,
        optionsOrStack: AppErrorOptions | string = {},
    ) {
        super(message);
        this.name = "AppError";
        this.statusCode = statusCode;

        // Keep compatibility with the previous constructor where the third
        // argument was an optional stack string.
        if (typeof optionsOrStack === "string") {
            if (optionsOrStack) this.stack = optionsOrStack;
        } else {
            this.code = optionsOrStack.code;
            this.retryable = optionsOrStack.retryable;
            this.fieldErrors = optionsOrStack.fieldErrors;
            if (optionsOrStack.stack) this.stack = optionsOrStack.stack;
        }

        if (!this.stack) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

export default AppError;
