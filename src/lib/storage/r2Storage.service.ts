import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  R2_PRIVATE_BUCKET,
  R2_PRIVATE_DOWNLOAD_TTL_SECONDS,
  R2_PUBLIC_BASE_URL,
  R2_UPLOAD_URL_TTL_SECONDS,
} from "../../config/ENV";
import { getR2Client } from "./r2Client";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const bodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body || typeof body !== "object") throw new Error("R2 returned an empty object body.");
  const candidate = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof candidate.transformToByteArray !== "function") throw new Error("R2 response body is not readable in this runtime.");
  return Buffer.from(await candidate.transformToByteArray());
};

export const r2StorageService = {
  async createUploadUrl(params: { key: string; contentType: string }) {
    const client = getR2Client();
    const command = new PutObjectCommand({
      Bucket: R2_PRIVATE_BUCKET,
      Key: params.key,
      ContentType: params.contentType,
    });
    return getSignedUrl(client, command, {
      expiresIn: R2_UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(["content-type"]),
    });
  },

  async headObject(bucket: string, key: string) {
    return getR2Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  },

  async getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
    const response = await getR2Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return bodyToBuffer(response.Body);
  },

  async getObjectPrefix(bucket: string, key: string, bytes = 16): Promise<Buffer> {
    const response = await getR2Client().send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=0-${Math.max(0, bytes - 1)}`,
    }));
    return bodyToBuffer(response.Body);
  },

  async putObject(params: { bucket: string; key: string; body: Buffer; contentType: string; isPublic: boolean }) {
    return getR2Client().send(new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ContentLength: params.body.length,
      CacheControl: params.isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
    }));
  },

  async copyObject(params: { sourceBucket: string; sourceKey: string; destinationBucket: string; destinationKey: string; contentType: string; isPublic: boolean }) {
    return getR2Client().send(new CopyObjectCommand({
      Bucket: params.destinationBucket,
      Key: params.destinationKey,
      CopySource: `${params.sourceBucket}/${params.sourceKey}`,
      MetadataDirective: "REPLACE",
      ContentType: params.contentType,
      CacheControl: params.isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
    }));
  },

  async deleteObject(bucket: string, key: string) {
    await getR2Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  async createPrivateDownloadUrl(bucket: string, key: string, filename?: string) {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"` } : {}),
    });
    return getSignedUrl(getR2Client(), command, { expiresIn: R2_PRIVATE_DOWNLOAD_TTL_SECONDS });
  },

  publicUrl(key: string): string {
    if (!R2_PUBLIC_BASE_URL) throw new Error("R2_PUBLIC_BASE_URL is not configured.");
    return `${trimTrailingSlash(R2_PUBLIC_BASE_URL)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  },

  async probe() {
    const client = getR2Client();
    const publicBucket = process.env.R2_PUBLIC_BUCKET?.trim();
    const privateBucket = process.env.R2_PRIVATE_BUCKET?.trim();
    if (!publicBucket || !privateBucket) throw new Error("R2 bucket names are not configured.");
    const [publicResult, privateResult] = await Promise.allSettled([
      client.send(new HeadBucketCommand({ Bucket: publicBucket })),
      client.send(new HeadBucketCommand({ Bucket: privateBucket })),
    ]);
    return {
      ok: publicResult.status === "fulfilled" && privateResult.status === "fulfilled",
      publicBucket: publicResult.status === "fulfilled",
      privateBucket: privateResult.status === "fulfilled",
    };
  },
};
