import { createHash, randomBytes } from "node:crypto";
import status from "http-status";
import redis from "../../config/redis";
import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import type { IRequestUser } from "../../types/requestUser.interface";
import { PublicWebsiteService } from "./publicWebsite.service";
import { assertPreviewExpectation, validPreviewEnvelope, type WebsitePreviewSessionInput } from "./websitePreviewContract";
import { getAdminId } from "../../lib/utils/resolveAdminId";

const TTL_SECONDS = 10 * 60;
const PREFIX = "website:preview-session:v1:";
const tokenPattern = /^[A-Za-z0-9_-]{40,96}$/;
const keyFor = (token: string) => `${PREFIX}${createHash("sha256").update(token).digest("hex")}`;

type PreviewSessionEnvelope = {
  version: 1;
  websiteId: string;
  adminId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  projection: Awaited<ReturnType<typeof PublicWebsiteService.getPreviewWebsite>>;
};

const create = async (user: IRequestUser, payload?: WebsitePreviewSessionInput) => {
  const hasOverride = Boolean(payload && ((payload.website && Object.keys(payload.website).length) || (payload.pages && payload.pages.length)));
  if (hasOverride && payload?.expected) throw new AppError(status.BAD_REQUEST, "A saved preview cannot contain editor overrides", { code: "WEBSITE_PREVIEW_CONTRACT_MISMATCH", retryable: false });
  const projection = hasOverride ? await PublicWebsiteService.getEditorStatePreviewWebsite(payload!, user) : await PublicWebsiteService.getPreviewWebsite(user);
  assertPreviewExpectation(projection, payload?.expected);
  const adminId = await getAdminId(user);
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + TTL_SECONDS * 1000);
  const envelope: PreviewSessionEnvelope = {
    version: 1,
    websiteId: projection.website.id,
    adminId,
    createdBy: user.id,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    projection,
  };
  try {
    const result = await redis.set(keyFor(token), JSON.stringify(envelope), "EX", TTL_SECONDS, "NX");
    if (result !== "OK") throw new Error("preview token collision");
  } catch {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Secure website preview is temporarily unavailable", {
      code: "WEBSITE_PREVIEW_SESSION_UNAVAILABLE",
      retryable: true,
    });
  }
  return { previewToken: token, expiresAt: expiresAt.toISOString(), websiteId: projection.website.id, draftRevisionNumber: projection.website.draftRevisionNumber, previewContractVersion: 1 as const };
};

const get = async (token: string) => {
  if (!tokenPattern.test(token)) throw new AppError(status.NOT_FOUND, "Website preview not found");
  let raw: string | null = null;
  try { raw = await redis.get(keyFor(token)); } catch {
    throw new AppError(status.SERVICE_UNAVAILABLE, "Secure website preview is temporarily unavailable", { code: "WEBSITE_PREVIEW_SESSION_UNAVAILABLE", retryable: true });
  }
  if (!raw) throw new AppError(status.GONE, "Website preview has expired", { code: "WEBSITE_PREVIEW_SESSION_EXPIRED", retryable: false });
  let session: PreviewSessionEnvelope;
  try { session = JSON.parse(raw) as PreviewSessionEnvelope; } catch { throw new AppError(status.GONE, "Website preview has expired"); }
  if (!validPreviewEnvelope(session, Date.now(), TTL_SECONDS)) throw new AppError(status.GONE, "Website preview has expired");

  // Tenant/account status is checked again when the bearer preview is consumed.
  // A suspended/deleted tenant therefore cannot keep a previously issued preview alive.
  const website = await prisma.businessWebsite.findUnique({
    where: { id: session.websiteId },
    select: { id: true, adminId: true, admin: { select: { lifecycleStatus: true, user: { select: { id: true, status: true } } } } },
  });
  if (!website || website.adminId !== session.adminId || website.admin.user.status !== "ACTIVE" || website.admin.user.id !== session.createdBy || website.admin.lifecycleStatus !== "ACTIVE") {
    throw new AppError(status.GONE, "Website preview is no longer available");
  }
  return session.projection;
};

export const WebsitePreviewSessionService = { create, get, TTL_SECONDS };
