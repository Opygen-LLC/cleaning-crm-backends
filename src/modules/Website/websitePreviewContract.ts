import status from "http-status";
import AppError from "../../errorHelper/AppError";
import type { WebsiteEditorStateInput } from "./website.interface";

export const WEBSITE_PREVIEW_CONTRACT_VERSION = 1 as const;
export interface WebsitePreviewExpectation {
  websiteId: string; draftRevisionNumber: number; profileVersion: string;
}
export type WebsitePreviewSessionInput = WebsiteEditorStateInput & { expected?: WebsitePreviewExpectation };

type PreviewIdentity = { website: { id: string; draftRevisionNumber?: number; previewProfileVersion?: string; preview?: boolean } };
export function assertPreviewExpectation(projection: PreviewIdentity, expected?: WebsitePreviewExpectation): void {
  if (!expected) return; // Existing Studio callers retain their editor-state preview contract.
  if (projection.website.preview !== true || projection.website.id !== expected.websiteId ||
      projection.website.draftRevisionNumber !== expected.draftRevisionNumber || projection.website.previewProfileVersion !== expected.profileVersion) {
    throw new AppError(status.CONFLICT, "The saved website changed. Reload the saved details before opening its preview.", {
      code: "WEBSITE_PREVIEW_REVISION_CONFLICT", retryable: false,
    });
  }
}

/** Reject malformed cache envelopes and dates rather than accidentally making a
 * bearer preview immortal. The session can never exceed its issued lifetime. */
export function validPreviewEnvelope(value: unknown, now: number, maxLifetimeSeconds: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || ![row.websiteId, row.adminId, row.createdBy].every(id => typeof id === "string" && id.length > 0) ||
      typeof row.createdAt !== "string" || typeof row.expiresAt !== "string") return false;
  const createdAt = Date.parse(row.createdAt), expiresAt = Date.parse(row.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now || expiresAt <= now ||
      expiresAt <= createdAt || expiresAt - createdAt > maxLifetimeSeconds * 1000) return false;
  const projection = row.projection as PreviewIdentity | null | undefined;
  return Boolean(projection && typeof projection === "object" && projection.website?.id === row.websiteId && projection.website.preview === true);
}
