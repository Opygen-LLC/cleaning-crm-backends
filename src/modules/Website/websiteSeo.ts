const compact = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() || null;

const truncateAtWord = (value: string, max: number) => {
  if (value.length <= max) return value;
  const sliced = value.slice(0, Math.max(1, max - 1)).trimEnd();
  const boundary = sliced.lastIndexOf(" ");
  const safe = boundary >= Math.floor(max * 0.65) ? sliced.slice(0, boundary) : sliced;
  return `${safe.trimEnd()}…`;
};

export interface WebsiteSeoBusinessInput {
  businessName: string;
  city?: string | null;
  businessDescription?: string | null;
}

/**
 * Deterministic SEO defaults built from canonical CRM business data. Owners can
 * override these in Website Studio, but a newly provisioned tenant still gets
 * a useful search title/description without duplicating business content into
 * the website CMS.
 */
export const buildDefaultWebsiteSeo = (input: WebsiteSeoBusinessInput) => {
  const businessName = compact(input.businessName) ?? "Cleaning business";
  const city = compact(input.city);
  const businessDescription = compact(input.businessDescription);

  const rawTitle = city
    ? `${businessName} | Professional Cleaning in ${city}`
    : `${businessName} | Professional Cleaning Services`;

  const fallbackDescription = city
    ? `Professional cleaning services from ${businessName} in ${city}. View services, reviews and service areas, then book online or request an estimate.`
    : `Professional cleaning services from ${businessName}. View services, reviews and service areas, then book online or request an estimate.`;

  return {
    title: truncateAtWord(rawTitle, 70),
    description: truncateAtWord(businessDescription ?? fallbackDescription, 180),
  };
};
