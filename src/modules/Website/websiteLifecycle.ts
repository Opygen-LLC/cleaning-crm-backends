/**
 * Canonical BusinessWebsite lifecycle.
 *
 * PROVISIONED  Automatically-created tenant website that has not been edited.
 * DRAFT        Pre-launch website with tenant changes but no live publication.
 * PUBLISHED    A live publishedSnapshot exists. Later draft edits do not change
 *              this status; hasUnpublishedChanges tracks those edits.
 * SUSPENDED    Website is administratively unavailable and must never be served.
 */
export const WEBSITE_STATUS = {
  PROVISIONED: "PROVISIONED",
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  SUSPENDED: "SUSPENDED",
} as const;

export type WebsiteLifecycleStatus = typeof WEBSITE_STATUS[keyof typeof WEBSITE_STATUS];

export const isWebsiteLifecycleStatus = (value: unknown): value is WebsiteLifecycleStatus =>
  typeof value === "string" && Object.values(WEBSITE_STATUS).includes(value as WebsiteLifecycleStatus);

/**
 * Saving/editing a never-published provisioned website moves it to DRAFT.
 * A live website stays PUBLISHED while its working copy changes, otherwise the
 * public runtime would incorrectly take the live site offline on every edit.
 */
export const statusAfterDraftMutation = (current: WebsiteLifecycleStatus): WebsiteLifecycleStatus => {
  if (current === WEBSITE_STATUS.PROVISIONED) return WEBSITE_STATUS.DRAFT;
  return current;
};
