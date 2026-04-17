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
            schema.parse(data);
            next();
        } catch (error: any) {
            if (error instanceof ZodError) {
                const errors = error.issues.map((issue) => ({
                    path: issue.path.join("."),
                    message: issue.message,
                }));
                return res.status(400).json({ errors });
            }
            next(error);
        }
    };
};
