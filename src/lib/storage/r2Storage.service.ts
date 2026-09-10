import {
  R2_PRIVATE_BUCKET,
  R2_PRIVATE_DOWNLOAD_TTL_SECONDS,
  R2_PUBLIC_BASE_URL,
  R2_UPLOAD_URL_TTL_SECONDS,
} from "../../config/ENV";
import { createR2PresignedUrl, r2SignedFetch } from "./r2Client";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const cleanEtag = (value: string | null) => value?.replace(/^"|"$/g, "") ?? undefined;

export const r2StorageService = {
  async createUploadUrl(params: { key: string; contentType: string }) {
    return createR2PresignedUrl({
      method: "PUT",
      bucket: R2_PRIVATE_BUCKET,
      key: params.key,
      expiresIn: R2_UPLOAD_URL_TTL_SECONDS,
      headers: { "content-type": params.contentType },
    });
  },

  async headObject(bucket: string, key: string) {
    const response = await r2SignedFetch({ method: "HEAD", bucket, key });
    return {
      ContentLength: Number(response.headers.get("content-length") ?? 0),
      ContentType: response.headers.get("content-type") ?? undefined,
      ETag: response.headers.get("etag") ?? undefined,
    };
  },

  async getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
    const response = await r2SignedFetch({ method: "GET", bucket, key });
    return Buffer.from(await response.arrayBuffer());
  },

  async getObjectPrefix(bucket: string, key: string, bytes = 16): Promise<Buffer> {
    const response = await r2SignedFetch({
      method: "GET",
      bucket,
      key,
      headers: { range: `bytes=0-${Math.max(0, bytes - 1)}` },
    });
    return Buffer.from(await response.arrayBuffer());
  },

  async putObject(params: { bucket: string; key: string; body: Buffer; contentType: string; isPublic: boolean }) {
    const response = await r2SignedFetch({
      method: "PUT",
      bucket: params.bucket,
      key: params.key,
      body: params.body,
      headers: {
        "content-type": params.contentType,
        "cache-control": params.isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      },
    });
    return { ETag: response.headers.get("etag") ?? undefined };
  },

  async copyObject(params: { sourceBucket: string; sourceKey: string; destinationBucket: string; destinationKey: string; contentType: string; isPublic: boolean }) {
    const copySource = `/${encodeURIComponent(params.sourceBucket)}/${params.sourceKey.split("/").map(encodeURIComponent).join("/")}`;
    const response = await r2SignedFetch({
      method: "PUT",
      bucket: params.destinationBucket,
      key: params.destinationKey,
      headers: {
        "x-amz-copy-source": copySource,
        "x-amz-metadata-directive": "REPLACE",
        "content-type": params.contentType,
        "cache-control": params.isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      },
    });
    const body = await response.text().catch(() => "");
    const xmlEtag = body.match(/<ETag>(?:&quot;|\")?([^<\"]+)(?:&quot;|\")?<\/ETag>/i)?.[1];
    return { CopyObjectResult: { ETag: xmlEtag ?? cleanEtag(response.headers.get("etag")) } };
  },

  async deleteObject(bucket: string, key: string) {
    await r2SignedFetch({ method: "DELETE", bucket, key });
  },

  async createPrivateDownloadUrl(bucket: string, key: string, filename?: string) {
    const query = filename
      ? { "response-content-disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"` }
      : undefined;
    return createR2PresignedUrl({ method: "GET", bucket, key, expiresIn: R2_PRIVATE_DOWNLOAD_TTL_SECONDS, query });
  },

  async createPrivateReadUrl(bucket: string, key: string, filename?: string) {
    const query = filename
      ? { "response-content-disposition": `inline; filename="${filename.replace(/["\\\r\n]/g, "_")}"` }
      : undefined;
    return createR2PresignedUrl({ method: "GET", bucket, key, expiresIn: R2_PRIVATE_DOWNLOAD_TTL_SECONDS, query });
  },

  publicUrl(key: string): string {
    if (!R2_PUBLIC_BASE_URL) throw new Error("R2_PUBLIC_BASE_URL is not configured.");
    return `${trimTrailingSlash(R2_PUBLIC_BASE_URL)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  },

  async probe() {
    const publicBucket = process.env.R2_PUBLIC_BUCKET?.trim();
    const privateBucket = process.env.R2_PRIVATE_BUCKET?.trim();
    if (!publicBucket || !privateBucket) throw new Error("R2 bucket names are not configured.");
    const [publicResult, privateResult] = await Promise.allSettled([
      r2SignedFetch({ method: "HEAD", bucket: publicBucket, timeoutMs: 10_000 }),
      r2SignedFetch({ method: "HEAD", bucket: privateBucket, timeoutMs: 10_000 }),
    ]);
    return {
      ok: publicResult.status === "fulfilled" && privateResult.status === "fulfilled",
      publicBucket: publicResult.status === "fulfilled",
      privateBucket: privateResult.status === "fulfilled",
    };
  },
};
