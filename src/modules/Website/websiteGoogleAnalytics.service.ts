import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  BETTER_AUTH_SECRET,
  GOOGLE_ANALYTICS_OAUTH_CLIENT_ID,
  GOOGLE_ANALYTICS_OAUTH_CLIENT_SECRET,
  GOOGLE_ANALYTICS_OAUTH_REDIRECT_URI,
  GOOGLE_ANALYTICS_OAUTH_STATE_SECRET,
  GOOGLE_ANALYTICS_TOKEN_ENCRYPTION_KEY,
} from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";

const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const OAUTH_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/analytics.readonly"];

const timeoutSignal = () => AbortSignal.timeout(10_000);

const configuration = () => {
  const clientId = GOOGLE_ANALYTICS_OAUTH_CLIENT_ID;
  const clientSecret = GOOGLE_ANALYTICS_OAUTH_CLIENT_SECRET;
  const redirectUri = GOOGLE_ANALYTICS_OAUTH_REDIRECT_URI;
  const encryptionSecret = GOOGLE_ANALYTICS_TOKEN_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !redirectUri || !encryptionSecret || encryptionSecret.length < 32) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Google Analytics connection is not configured for this deployment", {
      code: "GOOGLE_ANALYTICS_NOT_CONFIGURED",
      retryable: false,
    });
  }
  return { clientId, clientSecret, redirectUri, encryptionSecret };
};

const isConfigured = () => Boolean(
  GOOGLE_ANALYTICS_OAUTH_CLIENT_ID &&
  GOOGLE_ANALYTICS_OAUTH_CLIENT_SECRET &&
  GOOGLE_ANALYTICS_OAUTH_REDIRECT_URI &&
  GOOGLE_ANALYTICS_TOKEN_ENCRYPTION_KEY &&
  GOOGLE_ANALYTICS_TOKEN_ENCRYPTION_KEY.length >= 32,
);

const encryptionKey = (secret: string) => createHash("sha256").update(secret).digest();

const encryptRefreshToken = (value: string, secret: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
};

const decryptRefreshToken = (value: string, secret: string) => {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Stored Google Analytics credentials are invalid", {
      code: "GOOGLE_ANALYTICS_CREDENTIAL_INVALID",
      retryable: false,
    });
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Stored Google Analytics credentials could not be decrypted", {
      code: "GOOGLE_ANALYTICS_CREDENTIAL_INVALID",
      retryable: false,
    });
  }
};

const stateSecret = () => GOOGLE_ANALYTICS_OAUTH_STATE_SECRET || BETTER_AUTH_SECRET;

const makeState = (adminId: string, userId: string) => {
  const secret = stateSecret();
  if (!secret) throw new AppError(status.SERVICE_UNAVAILABLE, "OAuth state signing is not configured");
  const payload = Buffer.from(JSON.stringify({ adminId, userId, exp: Date.now() + 10 * 60_000, nonce: randomBytes(16).toString("hex") })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

const verifyState = (state: string, adminId: string, userId: string) => {
  const secret = stateSecret();
  const [payload, signature] = state.split(".");
  if (!secret || !payload || !signature) throw new AppError(status.BAD_REQUEST, "Invalid Google Analytics OAuth state");
  const expected = createHmac("sha256", secret).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { supplied = Buffer.alloc(0); }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new AppError(status.BAD_REQUEST, "Invalid Google Analytics OAuth state");
  }
  let parsed: { adminId?: string; userId?: string; exp?: number };
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new AppError(status.BAD_REQUEST, "Invalid Google Analytics OAuth state"); }
  if (parsed.adminId !== adminId || parsed.userId !== userId || !parsed.exp || parsed.exp < Date.now()) {
    throw new AppError(status.BAD_REQUEST, "Google Analytics OAuth state has expired or does not match this account");
  }
};

const fetchJson = async <T>(url: string, init: RequestInit, errorCode: string): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: timeoutSignal() });
  } catch {
    throw new AppError(status.BAD_GATEWAY, "Google Analytics is temporarily unavailable", { code: errorCode, retryable: true });
  }
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const message = typeof body?.error_description === "string"
      ? body.error_description
      : typeof body?.error?.message === "string"
        ? body.error.message
        : "Google Analytics request failed";
    throw new AppError(response.status === 401 ? status.UNAUTHORIZED : status.BAD_GATEWAY, message, {
      code: errorCode,
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  return body as T;
};

const websiteForAdmin = async (adminId: string) => {
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website not found");
  return website;
};

const accessTokenForConnection = async (connection: { refreshTokenEncrypted: string }) => {
  const cfg = configuration();
  const refreshToken = decryptRefreshToken(connection.refreshTokenEncrypted, cfg.encryptionSecret);
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const token = await fetchJson<{ access_token: string; expires_in?: number }>(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, "GOOGLE_ANALYTICS_TOKEN_REFRESH_FAILED");
  if (!token.access_token) throw new AppError(status.BAD_GATEWAY, "Google did not return an access token");
  return token.access_token;
};

const getConnection = async (websiteId: string) => prisma.websiteGoogleAnalyticsConnection.findUnique({ where: { websiteId } });

const connect = async (user: IRequestUser) => {
  const cfg = configuration();
  const adminId = await getAdminId(user);
  await websiteForAdmin(adminId);
  const state = makeState(adminId, user.id);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: OAUTH_SCOPES.join(" "),
    state,
  });
  return { authUrl: `${OAUTH_AUTHORIZE_URL}?${params.toString()}` };
};

const callback = async (payload: { code: string; state: string }, user: IRequestUser) => {
  const cfg = configuration();
  const adminId = await getAdminId(user);
  const website = await websiteForAdmin(adminId);
  verifyState(payload.state, adminId, user.id);

  const existing = await getConnection(website.id);
  const token = await fetchJson<{ access_token: string; refresh_token?: string }>(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: payload.code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  }, "GOOGLE_ANALYTICS_OAUTH_EXCHANGE_FAILED");

  const refreshToken = token.refresh_token || (existing ? decryptRefreshToken(existing.refreshTokenEncrypted, cfg.encryptionSecret) : null);
  if (!refreshToken) {
    throw new AppError(status.BAD_REQUEST, "Google did not issue an offline refresh token. Disconnect the app in your Google Account and connect again.", {
      code: "GOOGLE_ANALYTICS_REFRESH_TOKEN_MISSING",
      retryable: false,
    });
  }

  let googleEmail: string | null = existing?.googleEmail ?? null;
  if (token.access_token) {
    try {
      const info = await fetchJson<{ email?: string }>(USERINFO_URL, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      }, "GOOGLE_ANALYTICS_USERINFO_FAILED");
      googleEmail = info.email?.trim().toLowerCase() || googleEmail;
    } catch {
      // Email is display-only; analytics access remains valid without userinfo.
    }
  }

  await prisma.websiteGoogleAnalyticsConnection.upsert({
    where: { websiteId: website.id },
    create: {
      websiteId: website.id,
      refreshTokenEncrypted: encryptRefreshToken(refreshToken, cfg.encryptionSecret),
      googleEmail,
    },
    update: {
      refreshTokenEncrypted: encryptRefreshToken(refreshToken, cfg.encryptionSecret),
      googleEmail,
    },
  });
  return getStatus(user);
};

const listProperties = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await websiteForAdmin(adminId);
  const connection = await getConnection(website.id);
  if (!connection) throw new AppError(status.CONFLICT, "Connect a Google Analytics account first", { code: "GOOGLE_ANALYTICS_NOT_CONNECTED" });
  const token = await accessTokenForConnection(connection);
  const data = await fetchJson<{ accountSummaries?: Array<{ displayName?: string; propertySummaries?: Array<{ property?: string; displayName?: string }> }> }>(
    `${ADMIN_API}/accountSummaries?pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` } },
    "GOOGLE_ANALYTICS_PROPERTIES_FAILED",
  );
  const properties = (data.accountSummaries ?? []).flatMap((account) =>
    (account.propertySummaries ?? []).map((property) => ({
      propertyId: (property.property ?? "").replace(/^properties\//, ""),
      propertyName: property.displayName || property.property || "Google Analytics property",
      accountName: account.displayName || null,
    })),
  ).filter((property) => /^\d+$/.test(property.propertyId));
  return { properties };
};

const selectProperty = async (propertyId: string, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await websiteForAdmin(adminId);
  const connection = await getConnection(website.id);
  if (!connection) throw new AppError(status.CONFLICT, "Connect a Google Analytics account first", { code: "GOOGLE_ANALYTICS_NOT_CONNECTED" });
  const token = await accessTokenForConnection(connection);
  const data = await fetchJson<{ dataStreams?: Array<{ name?: string; displayName?: string; type?: string; webStreamData?: { measurementId?: string; defaultUri?: string } }> }>(
    `${ADMIN_API}/properties/${encodeURIComponent(propertyId)}/dataStreams?pageSize=200`,
    { headers: { Authorization: `Bearer ${token}` } },
    "GOOGLE_ANALYTICS_STREAMS_FAILED",
  );
  const stream = (data.dataStreams ?? []).find((candidate) => candidate.type === "WEB_DATA_STREAM" && candidate.webStreamData?.measurementId)
    ?? (data.dataStreams ?? []).find((candidate) => candidate.webStreamData?.measurementId);
  const measurementId = stream?.webStreamData?.measurementId?.trim().toUpperCase();
  if (!measurementId || !/^G-[A-Z0-9]{5,20}$/.test(measurementId)) {
    throw new AppError(status.UNPROCESSABLE_ENTITY, "The selected GA4 property does not have a web data stream with a Measurement ID", {
      code: "GOOGLE_ANALYTICS_WEB_STREAM_MISSING",
      retryable: false,
    });
  }
  const available = await listProperties(user);
  const selected = available.properties.find((property) => property.propertyId === propertyId);
  if (!selected) throw new AppError(status.FORBIDDEN, "The selected Google Analytics property is not available to this account");

  await prisma.websiteGoogleAnalyticsConnection.update({
    where: { websiteId: website.id },
    data: {
      propertyId,
      propertyName: selected.propertyName,
      accountName: selected.accountName,
      measurementId,
    },
  });
  return { propertyId, propertyName: selected.propertyName, accountName: selected.accountName, measurementId };
};

const disconnect = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await websiteForAdmin(adminId);
  await prisma.websiteGoogleAnalyticsConnection.deleteMany({ where: { websiteId: website.id } });
  return { disconnected: true };
};

const getStatus = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await websiteForAdmin(adminId);
  if (!isConfigured()) {
    return { configured: false, connected: false, googleEmail: null, propertyId: null, propertyName: null, accountName: null, measurementId: null };
  }
  const connection = await getConnection(website.id);
  return {
    configured: true,
    connected: Boolean(connection),
    googleEmail: connection?.googleEmail ?? null,
    propertyId: connection?.propertyId ?? null,
    propertyName: connection?.propertyName ?? null,
    accountName: connection?.accountName ?? null,
    measurementId: connection?.measurementId ?? null,
  };
};

const metricNumber = (row: any, index: number) => Number(row?.metricValues?.[index]?.value ?? 0) || 0;
const dimension = (row: any, index: number) => String(row?.dimensionValues?.[index]?.value ?? "");

const getReport = async (days: number, user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await websiteForAdmin(adminId);
  const connection = await getConnection(website.id);
  if (!connection?.propertyId) {
    throw new AppError(status.CONFLICT, "Select a Google Analytics property before viewing reports", { code: "GOOGLE_ANALYTICS_PROPERTY_REQUIRED" });
  }
  const token = await accessTokenForConnection(connection);
  const authorization = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];
  const runReport = <T>(body: unknown) => fetchJson<T>(
    `${DATA_API}/properties/${encodeURIComponent(connection.propertyId!)}:runReport`,
    { method: "POST", headers: authorization, body: JSON.stringify({ dateRanges, ...body }) },
    "GOOGLE_ANALYTICS_REPORT_FAILED",
  );

  const [summary, pages, sources] = await Promise.all([
    runReport<any>({ metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
      { name: "screenPageViews" },
      { name: "keyEvents" },
      { name: "engagementRate" },
    ] }),
    runReport<any>({ dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }], orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: "10" }),
    runReport<any>({ dimensions: [{ name: "sessionSource" }], metrics: [{ name: "sessions" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "10" }),
  ]);
  const row = summary.rows?.[0];
  return {
    days,
    sessions: metricNumber(row, 0),
    users: metricNumber(row, 1),
    pageViews: metricNumber(row, 2),
    conversions: metricNumber(row, 3),
    engagementRate: metricNumber(row, 4),
    topPages: (pages.rows ?? []).map((item: any) => ({ path: dimension(item, 0), views: metricNumber(item, 0) })),
    sources: (sources.rows ?? []).map((item: any) => ({ source: dimension(item, 0) || "(direct)", sessions: metricNumber(item, 0) })),
  };
};

export const WebsiteGoogleAnalyticsService = {
  connect,
  callback,
  listProperties,
  selectProperty,
  disconnect,
  getStatus,
  getReport,
};
