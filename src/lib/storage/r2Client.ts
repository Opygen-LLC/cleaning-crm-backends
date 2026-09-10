import { createHash, createHmac } from "node:crypto";
import {
  R2_ACCESS_KEY_ID,
  R2_ENDPOINT,
  R2_REGION,
  R2_SECRET_ACCESS_KEY,
} from "../../config/ENV";

const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";
const MAX_ATTEMPTS = 3;

export interface R2RequestInput {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  bucket: string;
  key?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
}

interface R2Credentials {
  endpoint: URL;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();

const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const encodeKey = (key: string) => key.split("/").map(encodeRfc3986).join("/");

const normalizeHeaderValue = (value: string) => value.trim().replace(/\s+/g, " ");

const getCredentials = (): R2Credentials => {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("Cloudflare R2 is not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(R2_ENDPOINT);
  } catch {
    throw new Error("R2_ENDPOINT must be a valid https URL.");
  }
  if (endpoint.protocol !== "https:") throw new Error("R2_ENDPOINT must use https.");

  return {
    endpoint,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    region: R2_REGION || "auto",
  };
};

const buildObjectUrl = (endpoint: URL, bucket: string, key?: string, query?: Record<string, string>) => {
  const url = new URL(endpoint.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${encodeRfc3986(bucket)}${key ? `/${encodeKey(key)}` : ""}`;
  url.search = "";
  if (query) {
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  }
  return url;
};

const canonicalQueryString = (params: URLSearchParams) =>
  [...params.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => (aKey < bKey ? -1 : aKey > bKey ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

const amzTimestamp = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const deriveSigningKey = (secretAccessKey: string, dateStamp: string, region: string) => {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
};

const buildCanonicalHeaders = (url: URL, headers: Record<string, string>) => {
  const normalized: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = normalizeHeaderValue(value);
  const names = Object.keys(normalized).sort();
  return {
    canonicalHeaders: names.map((name) => `${name}:${normalized[name]}\n`).join(""),
    signedHeaders: names.join(";"),
  };
};

const signRequest = (input: R2RequestInput) => {
  const credentials = getCredentials();
  const now = new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(input.body ?? Buffer.alloc(0));
  const requestHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const url = buildObjectUrl(credentials.endpoint, input.bucket, input.key, input.query);
  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(url, requestHeaders);
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", deriveSigningKey(credentials.secretAccessKey, dateStamp, credentials.region))
    .update(stringToSign)
    .digest("hex");
  requestHeaders.Authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url, headers: requestHeaders };
};

const isRetryableStatus = (statusCode: number) => statusCode === 408 || statusCode === 429 || statusCode >= 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const r2SignedFetch = async (input: R2RequestInput): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const signed = signRequest(input);
      const response = await fetch(signed.url, {
        method: input.method,
        headers: signed.headers,
        body: input.body ? new Uint8Array(input.body) : undefined,
        signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
      });
      if (response.ok) return response;
      if (attempt < MAX_ATTEMPTS && isRetryableStatus(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
        continue;
      }
      const detail = input.method === "HEAD" ? "" : (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`Cloudflare R2 request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || (error instanceof Error && error.message.startsWith("Cloudflare R2 request failed (4"))) throw error;
      await sleep(100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Cloudflare R2 request failed.");
};

export const createR2PresignedUrl = (input: {
  method: "GET" | "PUT";
  bucket: string;
  key: string;
  expiresIn: number;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}) => {
  const credentials = getCredentials();
  const now = new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`;
  const url = buildObjectUrl(credentials.endpoint, input.bucket, input.key, input.query);
  const headers = input.headers ?? {};
  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(url, headers);

  url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  url.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(Math.max(1, Math.min(604800, Math.trunc(input.expiresIn)))));
  url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);

  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", deriveSigningKey(credentials.secretAccessKey, dateStamp, credentials.region))
    .update(stringToSign)
    .digest("hex");
  url.searchParams.set("X-Amz-Signature", signature);
  // URLSearchParams serializes spaces as "+", while AWS SigV4 requires RFC3986
  // percent-encoding. Re-serialize with the exact canonical encoder so the URL
  // the browser sends is byte-for-byte compatible with the signed query.
  url.search = canonicalQueryString(url.searchParams);
  return url.toString();
};
