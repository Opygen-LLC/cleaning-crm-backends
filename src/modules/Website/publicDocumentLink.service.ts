import { randomBytes } from "node:crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { EstimateStatus, QuoteStatus } from "../../generated/prisma/enums";
import { prisma } from "../../lib/prisma/prisma";
import {
  TenantPublicUrlService,
  type TenantPublicUrlResolution,
} from "./tenantPublicUrl.service";

export type PublicDocumentResourceType = "quote" | "estimate";

export const PUBLIC_DOCUMENT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const WEBSITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const publicDocumentNotFound = () =>
  new AppError(status.NOT_FOUND, "Public document not found", {
    code: "PUBLIC_DOCUMENT_NOT_FOUND",
    retryable: false,
  });

const generateCandidate = () => randomBytes(32).toString("base64url");

/**
 * Root-token documents share one public URL namespace. Check both backing
 * tables before assigning a candidate so quote and estimate tokens cannot
 * intentionally collide. Intra-table unique indexes remain the final race
 * protection; the 256-bit random token makes a cross-table race negligible.
 */
const generateUniqueToken = async (): Promise<string> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateCandidate();
    const [quote, estimate] = await Promise.all([
      prisma.quote.findUnique({ where: { publicToken: candidate }, select: { id: true } }),
      prisma.estimate.findUnique({ where: { publicToken: candidate }, select: { id: true } }),
    ]);
    if (!quote && !estimate) return candidate;
  }

  throw new AppError(
    status.INTERNAL_SERVER_ERROR,
    "Could not create a secure public document link. Please try again.",
    { code: "PUBLIC_DOCUMENT_TOKEN_GENERATION_FAILED", retryable: true },
  );
};

const resolveForAdmin = (adminId: string): Promise<TenantPublicUrlResolution> =>
  TenantPublicUrlService.resolveForAdminId(adminId);

const buildFromResolution = (
  resolution: Pick<TenantPublicUrlResolution, "origin">,
  input: { resourceType: PublicDocumentResourceType; token: string },
): string => {
  if (!PUBLIC_DOCUMENT_TOKEN_RE.test(input.token)) {
    throw new AppError(status.INTERNAL_SERVER_ERROR, "Public document token is invalid", {
      code: "PUBLIC_DOCUMENT_TOKEN_INVALID",
      retryable: false,
    });
  }
  return TenantPublicUrlService.buildRootDocumentUrl(resolution, input.token);
};

const buildPublicDocumentUrl = async (input: {
  adminId: string;
  resourceType: PublicDocumentResourceType;
  token: string;
}): Promise<string> =>
  buildFromResolution(await resolveForAdmin(input.adminId), input);

const resolveWebsiteAdminId = async (websiteId?: string): Promise<string | null> => {
  if (!websiteId) return null;
  if (!WEBSITE_ID_RE.test(websiteId)) throw publicDocumentNotFound();

  const website = await prisma.businessWebsite.findUnique({
    where: { id: websiteId },
    select: { adminId: true },
  });
  if (!website) throw publicDocumentNotFound();
  return website.adminId;
};

/**
 * Resolve the resource kind without returning commercial/customer data. The
 * routed website id is mandatory so a valid capability token cannot be used on
 * another tenant hostname.
 */
const resolveResourceTypeForWebsite = async (
  token: string,
  websiteId: string,
): Promise<PublicDocumentResourceType> => {
  if (!PUBLIC_DOCUMENT_TOKEN_RE.test(token)) throw publicDocumentNotFound();
  const adminId = await resolveWebsiteAdminId(websiteId);
  if (!adminId) throw publicDocumentNotFound();

  const [quote, estimate] = await Promise.all([
    prisma.quote.findFirst({
      where: { publicToken: token, adminId, status: { not: QuoteStatus.DRAFT }, publishedAt: { not: null } },
      select: { id: true },
    }),
    prisma.estimate.findFirst({
      where: { publicToken: token, adminId, status: { not: EstimateStatus.DRAFT }, publishedAt: { not: null } },
      select: { id: true },
    }),
  ]);

  // Fail closed on the theoretically possible cross-table collision rather
  // than guessing which customer's document to expose.
  if (Boolean(quote) === Boolean(estimate)) throw publicDocumentNotFound();
  return quote ? "quote" : "estimate";
};

export const PublicDocumentLinkService = {
  buildFromResolution,
  buildPublicDocumentUrl,
  generateUniqueToken,
  isValidToken: (value: string) => PUBLIC_DOCUMENT_TOKEN_RE.test(value),
  resolveForAdmin,
  resolveResourceTypeForWebsite,
  resolveWebsiteAdminId,
};
