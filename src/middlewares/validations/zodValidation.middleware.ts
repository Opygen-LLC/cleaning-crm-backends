import { Response, NextFunction, Request } from "express";
import { ZodError, ZodSchema } from "zod";

export enum ValidationProperty {
    BODY = "body",
    QUERY = "query",
    PARAMS = "params",
}

// Generic validation middleware
export const zodValidate = (
    schema: ZodSchema,
    property: ValidationProperty,
) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const data = req[property];

        try {
            const parsed = schema.parse(data);
            // Body schemas may trim/normalise values. Persist the parsed payload
            // so service code receives exactly what was validated. Express 5's
            // req.query is getter-backed, so only replace mutable properties.
            if (property === ValidationProperty.BODY) req.body = parsed;
            if (property === ValidationProperty.PARAMS) req.params = parsed as typeof req.params;
            next();
        } catch (error: unknown) {
            // Route validation must use the same Phase-1 error envelope as every
            // other API failure; do not bypass the global handler with { errors }.
            if (error instanceof ZodError) return next(error);
            return next(error);
        }
    };
};
