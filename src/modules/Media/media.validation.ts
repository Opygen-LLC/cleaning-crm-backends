import { z } from "zod";
import { MEDIA_PURPOSES } from "./media.types";

const purpose = z.enum(MEDIA_PURPOSES);
const optionalEntityId = z.string().trim().uuid().optional();

export const mediaValidation = {
  initiateUpload: z.object({
    purpose,
    entityId: optionalEntityId,
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(3).max(100).transform((value) => value.toLowerCase()),
    size: z.number().int().positive().max(100 * 1024 * 1024),
  }).strict(),
  serverUploadFields: z.object({
    purpose,
    entityId: optionalEntityId,
  }).strict(),
  uploadParams: z.object({ uploadId: z.string().uuid() }).strict(),
  assetParams: z.object({ assetId: z.string().uuid() }).strict(),
};
