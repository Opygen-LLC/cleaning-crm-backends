import { TFieldErrors } from "../interface/error.interface";
import type { ErrorKind } from "./errorClassification";

export interface AppErrorOptions {
    code?: string;
    retryable?: boolean;
    fieldErrors?: TFieldErrors;
    stack?: string;
    kind?: ErrorKind;
}

class AppError extends Error {
    public statusCode: number;
    public code?: string;
    public retryable?: boolean;
    public fieldErrors?: TFieldErrors;
    public kind?: ErrorKind;

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
            this.kind = optionsOrStack.kind;
            if (optionsOrStack.stack) this.stack = optionsOrStack.stack;
        }

        if (!this.stack) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

export default AppError;
