import { z } from "zod";

export const clientErrorSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  stack: z.string().max(6000).nullable().optional(),
  digest: z.string().max(256).nullable().optional(),
  route: z.string().trim().min(1).max(800),
  section: z.string().trim().min(1).max(120),
  releaseVersion: z.string().trim().min(1).max(160),
  browser: z.string().trim().min(1).max(600),
  apiRequestId: z.string().trim().max(160).nullable().optional(),
  relatedTraceId: z.string().trim().regex(/^[0-9a-f]{32}$/i).nullable().optional(),
  componentStack: z.string().max(6000).nullable().optional(),
}).strict();

export type ClientErrorPayload = z.infer<typeof clientErrorSchema>;
