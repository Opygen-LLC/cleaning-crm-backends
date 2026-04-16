import { Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import { ProtectedRequest } from "../../types/protected-request";

// Generic validation middleware
export const zodValidate = (
  schema: ZodSchema,
  property: "body" | "query" | "params"
) => {
  return (req: ProtectedRequest, res: Response, next: NextFunction) => {
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
