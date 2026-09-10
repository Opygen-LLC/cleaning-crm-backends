import { S3Client } from "@aws-sdk/client-s3";
import {
  R2_ACCESS_KEY_ID,
  R2_ENDPOINT,
  R2_REGION,
  R2_SECRET_ACCESS_KEY,
} from "../../config/ENV";

let client: S3Client | null = null;

export const getR2Client = (): S3Client => {
  if (client) return client;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("Cloudflare R2 is not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.");
  }

  client = new S3Client({
    region: R2_REGION || "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    maxAttempts: 3,
  });
  return client;
};
