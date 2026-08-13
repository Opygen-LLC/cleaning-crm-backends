import status from "http-status";
import z from "zod";
import { TErrorResponse, TErrorSources } from "../interface/error.interface";
import { buildFieldErrors } from "./errorContract";

export const handleZodError = (err: z.ZodError): TErrorResponse => {
    const errorSources: TErrorSources[] = err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
    }));

    return {
        success: false,
        statusCode: status.BAD_REQUEST,
        code: "VALIDATION_ERROR",
        message: "Please check the highlighted fields and try again.",
        errorSources,
        fieldErrors: buildFieldErrors(errorSources),
        retryable: false,
    };
};
