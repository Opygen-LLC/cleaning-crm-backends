import status from "http-status";
import AppError from "../../errorHelper/AppError";
import type { Prisma } from "../../generated/prisma/client";

type PageContent = { kind: string; content?: unknown };

export const contentImageUrls = (pages: readonly PageContent[]): string[] => {
  const urls = new Set<string>();
  for (const page of pages) {
    if (!page.content || typeof page.content !== "object" || Array.isArray(page.content)) continue;
    const content = page.content as Record<string, unknown>;
    const value = page.kind === "HOME" ? content.heroImageUrl : page.kind === "ABOUT" ? content.imageUrl : null;
    if (typeof value === "string" && value.trim()) urls.add(value.trim());
  }
  return [...urls];
};

/** New HOME media must be an image belonging to this website. Historical ABOUT
 * URLs retain their existing contract; this does not rewrite old snapshots. */
export async function assertOwnedHeroImages(
  db: Pick<Prisma.TransactionClient, "websiteAsset">,
  websiteId: string,
  pages: readonly PageContent[],
): Promise<void> {
  for (const url of contentImageUrls(pages.filter(page => page.kind === "HOME"))) {
    const asset = await db.websiteAsset.findFirst({
      where: { websiteId, url }, select: { mimeType: true },
    });
    if (!asset?.mimeType?.startsWith("image/")) {
      throw new AppError(status.BAD_REQUEST, "Upload or select a hero image belonging to this website.", {
        code: "WEBSITE_CONTENT_ASSET_INVALID", retryable: false,
      });
    }
  }
}
