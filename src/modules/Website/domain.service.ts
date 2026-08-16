import { randomBytes } from "node:crypto";
import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN, WEBSITE_CNAME_TARGET } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import type { WebsiteDomainCreateInput } from "./website.interface";
import { normalizeDomain } from "./websiteIdentity";

const getOwnedWebsite = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { id: true, subdomain: true } });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  return website;
};

const dnsRequirements = (domain: string, token: string) => ({
  ownership: {
    type: "TXT",
    host: `_cleancrm-verification.${domain}`,
    value: token,
  },
  routing: WEBSITE_CNAME_TARGET
    ? { type: "CNAME_OR_ALIAS", host: domain, value: WEBSITE_CNAME_TARGET }
    : null,
});

const addDomain = async (payload: WebsiteDomainCreateInput, user: IRequestUser) => {
  const website = await getOwnedWebsite(user);
  const domain = normalizeDomain(payload.domain);
  if (WEBSITE_BASE_DOMAIN && (domain === WEBSITE_BASE_DOMAIN || domain.endsWith(`.${WEBSITE_BASE_DOMAIN}`))) {
    throw new AppError(status.BAD_REQUEST, "Platform subdomains cannot be added as custom domains");
  }
  const existing = await prisma.websiteDomain.findUnique({ where: { domain }, select: { id: true } });
  if (existing) throw new AppError(status.CONFLICT, "This domain is already connected to another website");

  const verificationToken = randomBytes(32).toString("hex");
  return prisma.websiteDomain.create({
    data: {
      websiteId: website.id,
      domain,
      verificationToken,
      requiredDns: dnsRequirements(domain, verificationToken) as any,
    },
  });
};

const listDomains = async (user: IRequestUser) => {
  const website = await getOwnedWebsite(user);
  return prisma.websiteDomain.findMany({
    where: { websiteId: website.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
};

const removeDomain = async (domainId: string, user: IRequestUser) => {
  const website = await getOwnedWebsite(user);
  const domain = await prisma.websiteDomain.findFirst({ where: { id: domainId, websiteId: website.id }, select: { id: true } });
  if (!domain) throw new AppError(status.NOT_FOUND, "Website domain not found");
  await prisma.websiteDomain.delete({ where: { id: domainId } });
  return { id: domainId, deleted: true };
};

const setPrimaryDomain = async (domainId: string, user: IRequestUser) => {
  const website = await getOwnedWebsite(user);
  const domain = await prisma.websiteDomain.findFirst({ where: { id: domainId, websiteId: website.id } });
  if (!domain) throw new AppError(status.NOT_FOUND, "Website domain not found");
  if (domain.status !== "VERIFIED") throw new AppError(status.CONFLICT, "Verify the domain before making it primary");

  return prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${website.id}))`;
    await tx.websiteDomain.updateMany({ where: { websiteId: website.id, isPrimary: true }, data: { isPrimary: false } });
    return tx.websiteDomain.update({ where: { id: domainId }, data: { isPrimary: true } });
  });
};

/** Internal hook for Phase 7 DNS/provider verification. Never accepts adminId from a client. */
const updateVerificationState = async (
  domainId: string,
  state: { status: "PENDING" | "VERIFYING" | "VERIFIED" | "FAILED"; failureReason?: string | null; checkedAt?: Date },
) => prisma.websiteDomain.update({
  where: { id: domainId },
  data: {
    status: state.status,
    failureReason: state.failureReason ?? null,
    lastCheckedAt: state.checkedAt ?? new Date(),
    verifiedAt: state.status === "VERIFIED" ? new Date() : null,
  },
});

export const DomainService = { addDomain, listDomains, removeDomain, setPrimaryDomain, updateVerificationState };
