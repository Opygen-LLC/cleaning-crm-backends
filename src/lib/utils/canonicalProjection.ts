/**
 * Phase 0 canonical public projection helpers.
 * Public booking/estimate/website surfaces should consume these stable shapes
 * rather than independently exposing Prisma/AdminProfile internals.
 */
export const projectPublicBusiness = (admin: {
    businessName: string;
    businessLogo?: string | null;
    mobileNumber?: string | null;
    businessEmail?: string | null;
    address?: string | null;
    city?: string | null;
    zipcode?: string | null;
    country?: unknown | null;
    brandColor?: string | null;
    user?: { name?: string | null; email?: string | null } | null;
}) => ({
    name: admin.businessName,
    logoUrl: admin.businessLogo ?? null,
    phone: admin.mobileNumber ?? "",
    email: admin.businessEmail ?? admin.user?.email ?? "",
    address: admin.address ?? null,
    city: admin.city ?? null,
    postcode: admin.zipcode ?? null,
    country: admin.country ?? null,
    brandColor: admin.brandColor ?? "#000000",
});

export const projectCanonicalService = (service: {
    id: string;
    serviceName: string;
    description: string;
    basePriceGbp: number;
    duration: string;
    category: string;
    addOns?: unknown;
    legacyServiceType?: unknown | null;
}) => ({
    id: service.id,
    serviceCatalogId: service.id,
    name: service.serviceName,
    description: service.description,
    basePriceGbp: service.basePriceGbp,
    duration: service.duration,
    category: service.category,
    addOns: service.addOns ?? [],
    legacyServiceType: service.legacyServiceType ?? null,
});
