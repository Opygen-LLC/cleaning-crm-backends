import {
  R2_PRIVATE_BUCKET,
  R2_PRIVATE_DOWNLOAD_TTL_SECONDS,
  R2_PUBLIC_BASE_URL,
  R2_UPLOAD_URL_TTL_SECONDS,
} from "../../config/ENV";
import { createR2PresignedUrl, r2SignedFetch } from "./r2Client";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const cleanEtag = (value: string | null) => value?.replace(/^"|"$/g, "") ?? undefined;

const decodeXml = (value: string) => value
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&");

const xmlText = (xml: string, tag: string): string | undefined => {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]) : undefined;
};

const deleteWithConcurrency = async (bucket: string, keys: string[], concurrency = 12) => {
  let cursor = 0;
  let deleted = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, keys.length || 1)) }, async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      await r2SignedFetch({ method: "DELETE", bucket, key });
      deleted += 1;
    }
  });
  await Promise.all(workers);
  return deleted;
};

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

  async listObjects(params: { bucket: string; prefix: string; continuationToken?: string; maxKeys?: number }) {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix: params.prefix,
      "max-keys": String(Math.max(1, Math.min(1000, params.maxKeys ?? 1000))),
    };
    if (params.continuationToken) query["continuation-token"] = params.continuationToken;
    const response = await r2SignedFetch({ method: "GET", bucket: params.bucket, query, timeoutMs: 30_000 });
    const xml = await response.text();
    const keys = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/gi)]
      .map((match) => decodeXml(match[1]));
    return {
      keys,
      isTruncated: (xmlText(xml, "IsTruncated") ?? "false").toLowerCase() === "true",
      nextContinuationToken: xmlText(xml, "NextContinuationToken"),
    };
  },

  async deletePrefix(bucket: string, prefix: string) {
    let continuationToken: string | undefined;
    let deleted = 0;
    do {
      const page = await this.listObjects({ bucket, prefix, continuationToken, maxKeys: 1000 });
      if (page.keys.length) deleted += await deleteWithConcurrency(bucket, page.keys);
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      if (page.isTruncated && !continuationToken) throw new Error(`R2 list for ${prefix} was truncated without a continuation token.`);
    } while (continuationToken);
    return deleted;
  },

  async putLifecycleConfiguration(bucket: string, xml: string) {
    await r2SignedFetch({
      method: "PUT",
      bucket,
      query: { lifecycle: "" },
      body: Buffer.from(xml, "utf8"),
      headers: { "content-type": "application/xml" },
      timeoutMs: 30_000,
    });
  },

  async getLifecycleConfiguration(bucket: string) {
    const response = await r2SignedFetch({ method: "GET", bucket, query: { lifecycle: "" }, timeoutMs: 30_000 });
    return response.text();
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
