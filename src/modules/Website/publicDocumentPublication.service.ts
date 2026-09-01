import status from "http-status";
import type { Prisma } from "../../generated/prisma/client";
import { EstimateStatus, QuoteStatus } from "../../generated/prisma/enums";
import AppError from "../../errorHelper/AppError";
import { prisma } from "../../lib/prisma/prisma";
import {
  PublicDocumentLinkService,
  type PublicDocumentResourceType,
} from "./publicDocumentLink.service";
import type { TenantPublicUrlResolution } from "./tenantPublicUrl.service";

export type PublicDocumentDeliveryIntent = "DRAFT" | "PUBLISH" | "SEND";
type PublishIntent = Exclude<PublicDocumentDeliveryIntent, "DRAFT">;

export interface PreparedPublicDocumentCreation {
  status: "DRAFT" | "SENT";
  publicToken: string | null;
  publishedAt: Date | null;
  sentAt: Date | null;
  shareUrl: string | null;
}

export interface PublicDocumentPublicationResult {
  id: string;
  publicToken: string;
  publishedAt: Date;
  sentAt: Date | null;
  shareUrl: string;
}

type PublicationTxHook = (
  tx: Prisma.TransactionClient,
  publication: PublicDocumentPublicationResult,
) => Promise<void>;

const prepareCreation = async (input: {
  adminId: string;
  resourceType: PublicDocumentResourceType;
  deliveryIntent?: PublicDocumentDeliveryIntent;
}): Promise<PreparedPublicDocumentCreation> => {
  const deliveryIntent = input.deliveryIntent ?? "DRAFT";
  if (deliveryIntent === "DRAFT") {
    return {
      status: "DRAFT",
      publicToken: null,
      publishedAt: null,
      sentAt: null,
      shareUrl: null,
    };
  }

  // Resolve the tenant-owned public origin before any non-draft row is created.
  // If the website/domain cannot produce a canonical URL, creation fails closed
  // and no publicly-marked document is written.
  const resolution = await PublicDocumentLinkService.resolveForAdmin(input.adminId);
  const publicToken = await PublicDocumentLinkService.generateUniqueToken();
  const now = new Date();

  return {
    status: "SENT",
    publicToken,
    publishedAt: now,
    sentAt: deliveryIntent === "SEND" ? now : null,
    shareUrl: PublicDocumentLinkService.buildFromResolution(resolution, {
      resourceType: input.resourceType,
      token: publicToken,
    }),
  };
};

const ensureQuoteCanPublish = (existing: {
  status: QuoteStatus;
  validUntil: Date;
  publicToken: string | null;
  publishedAt: Date | null;
}, intent: PublishIntent) => {
  const terminal = ([QuoteStatus.ACCEPTED, QuoteStatus.DECLINED, QuoteStatus.EXPIRED] as QuoteStatus[]).includes(existing.status);
  if (terminal) {
    if (intent === "SEND") {
      throw new AppError(status.BAD_REQUEST, `Cannot send a quote that is ${existing.status.toLowerCase()}`, {
        code: "QUOTE_NOT_SENDABLE",
        retryable: false,
      });
    }
    if (!existing.publicToken || !existing.publishedAt) {
      throw new AppError(status.CONFLICT, "This quote has an incomplete public-link state and must be reconciled before it can be shared.", {
        code: "QUOTE_PUBLICATION_INVARIANT_BROKEN",
        retryable: false,
      });
    }
    return;
  }

  if (new Date() > existing.validUntil) {
    throw new AppError(status.CONFLICT, "This quote has expired and can no longer be published or sent.", {
      code: "QUOTE_EXPIRED",
      retryable: false,
    });
  }
};

const ensureEstimateCanPublish = (existing: {
  status: EstimateStatus;
  validUntil: Date;
  publicToken: string | null;
  publishedAt: Date | null;
}, intent: PublishIntent) => {
  const terminal = ([EstimateStatus.APPROVED, EstimateStatus.REJECTED, EstimateStatus.CONVERTED] as EstimateStatus[]).includes(existing.status);
  if (terminal) {
    if (intent === "SEND") {
      throw new AppError(status.BAD_REQUEST, `Cannot send an estimate that is ${existing.status.toLowerCase()}`, {
        code: "ESTIMATE_NOT_SENDABLE",
        retryable: false,
      });
    }
    if (!existing.publicToken || !existing.publishedAt) {
      throw new AppError(status.CONFLICT, "This estimate has an incomplete public-link state and must be reconciled before it can be shared.", {
        code: "ESTIMATE_PUBLICATION_INVARIANT_BROKEN",
        retryable: false,
      });
    }
    return;
  }

  if (new Date() > existing.validUntil) {
    throw new AppError(status.CONFLICT, "This estimate has expired and can no longer be published or sent.", {
      code: "ESTIMATE_EXPIRED",
      retryable: false,
    });
  }
};

const buildPublicationResult = (
  resolution: Pick<TenantPublicUrlResolution, "origin">,
  resourceType: PublicDocumentResourceType,
  row: {
    id: string;
    publicToken: string | null;
    publishedAt: Date | null;
    sentAt: Date | null;
  },
): PublicDocumentPublicationResult => {
  if (!row.publicToken || !row.publishedAt) {
    throw new AppError(status.INTERNAL_SERVER_ERROR, "Public document publication did not satisfy the required invariant.", {
      code: "PUBLIC_DOCUMENT_PUBLICATION_INVARIANT_FAILED",
      retryable: true,
    });
  }
  return {
    id: row.id,
    publicToken: row.publicToken,
    publishedAt: row.publishedAt,
    sentAt: row.sentAt,
    shareUrl: PublicDocumentLinkService.buildFromResolution(resolution, {
      resourceType,
      token: row.publicToken,
    }),
  };
};

const publishQuote = async (input: {
  id: string;
  adminId: string;
  intent?: PublishIntent;
  onPublishedTx?: PublicationTxHook;
}): Promise<PublicDocumentPublicationResult> => {
  const intent = input.intent ?? "PUBLISH";
  const resolution = await PublicDocumentLinkService.resolveForAdmin(input.adminId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.quote.findFirst({
          where: { id: input.id, adminId: input.adminId },
          select: {
            id: true,
            status: true,
            validUntil: true,
            publicToken: true,
            publishedAt: true,
            sentAt: true,
          },
        });
        if (!existing) throw new AppError(status.NOT_FOUND, "Quote not found");
        ensureQuoteCanPublish(existing, intent);

        const isTerminal = ([QuoteStatus.ACCEPTED, QuoteStatus.DECLINED, QuoteStatus.EXPIRED] as QuoteStatus[]).includes(existing.status);
        const now = new Date();
        const publicToken = existing.publicToken ?? await PublicDocumentLinkService.generateUniqueToken();
        const row = isTerminal
          ? existing
          : await tx.quote.update({
              where: { id: existing.id },
              data: {
                ...(existing.publicToken ? {} : { publicToken }),
                ...(existing.status === QuoteStatus.DRAFT ? { status: QuoteStatus.SENT } : {}),
                ...(existing.publishedAt ? {} : { publishedAt: now }),
                ...(intent === "SEND" ? { sentAt: now } : {}),
              },
              select: { id: true, publicToken: true, publishedAt: true, sentAt: true },
            });

        const publication = buildPublicationResult(resolution, "quote", row);
        if (input.onPublishedTx) await input.onPublishedTx(tx, publication);
        return publication;
      });
    } catch (error) {
      const prismaCode = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      if (prismaCode === "P2002") continue;
      throw error;
    }
  }

  throw new AppError(status.INTERNAL_SERVER_ERROR, "Could not create a secure quote link. Please try again.", {
    code: "QUOTE_TOKEN_GENERATION_FAILED",
    retryable: true,
  });
};

const publishEstimate = async (input: {
  id: string;
  adminId: string;
  intent?: PublishIntent;
  onPublishedTx?: PublicationTxHook;
}): Promise<PublicDocumentPublicationResult> => {
  const intent = input.intent ?? "PUBLISH";
  const resolution = await PublicDocumentLinkService.resolveForAdmin(input.adminId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.estimate.findFirst({
          where: { id: input.id, adminId: input.adminId },
          select: {
            id: true,
            status: true,
            validUntil: true,
            publicToken: true,
            publishedAt: true,
            sentAt: true,
          },
        });
        if (!existing) throw new AppError(status.NOT_FOUND, "Estimate not found");
        ensureEstimateCanPublish(existing, intent);

        const isTerminal = ([EstimateStatus.APPROVED, EstimateStatus.REJECTED, EstimateStatus.CONVERTED] as EstimateStatus[]).includes(existing.status);
        const now = new Date();
        const publicToken = existing.publicToken ?? await PublicDocumentLinkService.generateUniqueToken();
        const row = isTerminal
          ? existing
          : await tx.estimate.update({
              where: { id: existing.id },
              data: {
                ...(existing.publicToken ? {} : { publicToken }),
                ...(existing.status === EstimateStatus.DRAFT ? { status: EstimateStatus.SENT } : {}),
                ...(existing.publishedAt ? {} : { publishedAt: now }),
                ...(intent === "SEND" ? { sentAt: now } : {}),
              },
              select: { id: true, publicToken: true, publishedAt: true, sentAt: true },
            });

        const publication = buildPublicationResult(resolution, "estimate", row);
        if (input.onPublishedTx) await input.onPublishedTx(tx, publication);
        return publication;
      });
    } catch (error) {
      const prismaCode = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      if (prismaCode === "P2002") continue;
      throw error;
    }
  }

  throw new AppError(status.INTERNAL_SERVER_ERROR, "Could not create a secure estimate link. Please try again.", {
    code: "ESTIMATE_TOKEN_GENERATION_FAILED",
    retryable: true,
  });
};

export const PublicDocumentPublicationService = {
  prepareCreation,
  publishQuote,
  publishEstimate,
};
