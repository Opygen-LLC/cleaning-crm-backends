import status from "http-status";
import AppError from "../../errorHelper/AppError";
import { WEBSITE_BASE_DOMAIN } from "../../config/ENV";
import { prisma } from "../../lib/prisma/prisma";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import type { IRequestUser } from "../../types/requestUser.interface";
import { publicationDeliveryDedupeKey } from "../../lib/outbox/publicWebsiteCacheOutbox";
import { TenantAccessResolver } from "../Entitlement/tenantAccessResolver.service";
import { WebsiteHostResolverService } from "./websiteHostResolver.service";

export type WebsiteReadinessState = "draft" | "preparing" | "live" | "temporarily_unavailable";
type StatusWebsite = { id: string; status: string; subdomain: string; publishedRevisionNumber: number | null };

export const buildCompactWebsiteStatus = (
  website: StatusWebsite,
  userId: string,
  organizationId: string,
  state: WebsiteReadinessState,
  publicUrl: string | null,
  validUntil = new Date(Date.now() + 30_000).toISOString(),
) => ({
  userId, organizationId, websiteId: website.id, status: website.status,
  subdomain: website.subdomain, publishedRevisionNumber: website.publishedRevisionNumber,
  state, publicUrl, checkedAt: new Date().toISOString(), validUntil,
});

/** No analytics, editor graph, revision history, or publishedSnapshot read. */
const getForUser = async (user: IRequestUser) => {
  const adminId = await getAdminId(user);
  const website = await prisma.businessWebsite.findUnique({
    where: { adminId },
    select: { id: true, status: true, subdomain: true, publishedRevisionNumber: true },
  });
  if (!website) throw new AppError(status.NOT_FOUND, "Business website has not been provisioned yet");
  const platformUrl = WEBSITE_BASE_DOMAIN ? `https://${website.subdomain}.${WEBSITE_BASE_DOMAIN}` : null;
  const present = (state: WebsiteReadinessState, publicUrl = platformUrl, validUntil?: string) =>
    buildCompactWebsiteStatus(website, user.id, adminId, state, publicUrl, validUntil);
  const access = await TenantAccessResolver.resolve(adminId);
  if (!access.access.dashboardAllowed || website.status === "SUSPENDED") return present("temporarily_unavailable");
  if (website.status !== "PUBLISHED" || !website.publishedRevisionNumber) return present("draft");
  if (!access.access.publicWebsiteAllowed) return present("temporarily_unavailable");
  const event = await prisma.outboxEvent.findUnique({
    where: { dedupeKey: publicationDeliveryDedupeKey(website.id, website.publishedRevisionNumber) },
    select: { status: true },
  });
  if (event?.status === "DEAD") return present("temporarily_unavailable");
  // A URL or PUBLISHED flag alone is not proof that this revision was delivered.
  if (!event || event.status !== "PROCESSED") return present("preparing");
  if (!WEBSITE_BASE_DOMAIN) return present("temporarily_unavailable");
  try {
    const route = await WebsiteHostResolverService.resolveHost(`${website.subdomain}.${WEBSITE_BASE_DOMAIN}`);
    if (route.websiteId !== website.id || route.availability !== "live") return present("temporarily_unavailable");
    return present("live", `https://${route.canonicalHost}`,
      new Date(Math.min(Date.now() + 30_000, Date.parse(route.accessValidUntil))).toISOString());
  } catch { return present("temporarily_unavailable"); }
};

export const WebsiteStatusService = { getForUser };
