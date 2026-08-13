export interface TErrorSources {
    path: string;
    message: string;
}

export type TFieldErrors = Record<string, string>;

/**
 * Stable API error envelope used by the global error handler.
 *
 * `errorSources` is intentionally retained for backwards compatibility with
 * older clients. New clients should prefer `code`, `fieldErrors`, `retryable`
 * and `requestId`.
 */
export interface TErrorResponse {
    statusCode?: number;
    success: boolean;
    code?: string;
    message: string;
    errorSources: TErrorSources[];
    fieldErrors?: TFieldErrors;
    retryable?: boolean;
    requestId?: string;
    stack?: string;
    error?: unknown;
}
