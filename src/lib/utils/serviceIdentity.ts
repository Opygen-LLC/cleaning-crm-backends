import { ServiceStatus, ServiceType } from "../../generated/prisma/enums";
import { prisma } from "../prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";

const NORMALIZED_LEGACY_SERVICE_NAMES: Record<string, ServiceType> = {
    residential_clean: ServiceType.RESIDENTIAL_CLEAN,
    residential_cleaning: ServiceType.RESIDENTIAL_CLEAN,
    standard_clean: ServiceType.RESIDENTIAL_CLEAN,
    standard_cleaning: ServiceType.RESIDENTIAL_CLEAN,
    deep_clean: ServiceType.DEEP_CLEAN,
    deep_cleaning: ServiceType.DEEP_CLEAN,
    office_clean: ServiceType.OFFICE_CLEAN,
    office_cleaning: ServiceType.OFFICE_CLEAN,
    end_of_tenancy: ServiceType.END_OF_TENANCY,
    end_of_tenancy_clean: ServiceType.END_OF_TENANCY,
    end_of_tenancy_cleaning: ServiceType.END_OF_TENANCY,
    carpet_clean: ServiceType.CARPET_CLEAN,
    carpet_cleaning: ServiceType.CARPET_CLEAN,
    window_clean: ServiceType.WINDOW_CLEAN,
    window_cleaning: ServiceType.WINDOW_CLEAN,
    move_in_out_clean: ServiceType.MOVE_IN_OUT_CLEAN,
    move_in_out_cleaning: ServiceType.MOVE_IN_OUT_CLEAN,
};

export const inferLegacyServiceType = (serviceName: string): ServiceType | null => {
    const normalized = serviceName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return NORMALIZED_LEGACY_SERVICE_NAMES[normalized] ?? null;
};

export interface ServiceIdentityInput {
    serviceCatalogId?: string | null;
    serviceType?: ServiceType | null;
}

export interface ResolvedServiceIdentity {
    serviceCatalogId: string | null;
    serviceType: ServiceType | null;
    serviceNameSnapshot: string;
    priceSnapshot: number | null;
    durationSnapshot: string | null;
}

/**
 * Resolve service identity inside one tenant. The catalog wins whenever a
 * catalog ID is supplied; a client cannot pair another tenant's catalog ID
 * with a trusted legacy enum. Legacy-only callers continue to work.
 */
export const resolveServiceIdentity = async (
    adminId: string,
    input: ServiceIdentityInput,
): Promise<ResolvedServiceIdentity> => {
    if (input.serviceCatalogId) {
        const catalog = await prisma.serviceCatalog.findFirst({
            where: {
                id: input.serviceCatalogId,
                adminId,
                status: ServiceStatus.ACTIVE,
            },
            select: {
                id: true,
                serviceName: true,
                basePrice: true,
                duration: true,
                legacyServiceType: true,
            },
        });
        if (!catalog) {
            throw new AppError(status.UNPROCESSABLE_ENTITY, "Service is not available for this business", {
                code: "SERVICE_NOT_AVAILABLE",
                retryable: false,
                fieldErrors: { serviceCatalogId: "Choose an active service from this business." },
            });
        }
        return {
            serviceCatalogId: catalog.id,
            serviceType: catalog.legacyServiceType ?? null,
            serviceNameSnapshot: catalog.serviceName,
            priceSnapshot: catalog.basePrice,
            durationSnapshot: catalog.duration,
        };
    }

    if (!input.serviceType) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "A service is required", {
            code: "SERVICE_REQUIRED",
            retryable: false,
            fieldErrors: { serviceCatalogId: "Choose a service." },
        });
    }

    // Compatibility bridge: if this tenant already has a canonical catalog row
    // mapped to the old enum, attach it automatically while preserving the enum.
    const catalogs = await prisma.serviceCatalog.findMany({
        where: {
            adminId,
            legacyServiceType: input.serviceType,
            status: ServiceStatus.ACTIVE,
        },
        orderBy: { createdAt: "asc" },
        take: 2,
        select: {
            id: true,
            serviceName: true,
            basePrice: true,
            duration: true,
        },
    });

    // Never guess when a tenant has more than one catalog service mapped to
    // the same legacy enum. Old callers remain valid, but the canonical FK is
    // attached only when the mapping is unambiguous.
    const catalog = catalogs.length === 1 ? catalogs[0] : null;

    return {
        serviceCatalogId: catalog?.id ?? null,
        serviceType: input.serviceType,
        serviceNameSnapshot: catalog?.serviceName ?? legacyServiceDisplayName(input.serviceType),
        priceSnapshot: catalog?.basePrice ?? null,
        durationSnapshot: catalog?.duration ?? null,
    };
};

const legacyServiceDisplayName = (serviceType: ServiceType | string): string =>
    serviceType
        .toLowerCase()
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

export const serviceDisplayName = (service: {
    serviceNameSnapshot?: string | null;
    serviceCatalog?: { serviceName: string } | null;
    serviceType?: ServiceType | string | null;
}): string =>
    service.serviceNameSnapshot ??
    service.serviceCatalog?.serviceName ??
    (service.serviceType ? legacyServiceDisplayName(service.serviceType) : null) ??
    "Service";


/**
 * Compatibility resolver for modules that historically stored a free-text
 * `serviceType` (quotes/estimates/templates). New clients should send
 * serviceCatalogId. Older clients may continue sending a catalog service name
 * or one of the historical display labels during the rolling migration.
 */
export const resolveFlexibleServiceIdentity = async (
    adminId: string,
    input: { serviceCatalogId?: string | null; serviceType?: string | null },
): Promise<ResolvedServiceIdentity> => {
    if (input.serviceCatalogId) {
        return resolveServiceIdentity(adminId, { serviceCatalogId: input.serviceCatalogId });
    }

    const serviceName = input.serviceType?.trim();
    if (!serviceName) {
        throw new AppError(status.UNPROCESSABLE_ENTITY, "A service is required", {
            code: "SERVICE_REQUIRED",
            retryable: false,
            fieldErrors: { serviceCatalogId: "Choose a service." },
        });
    }

    // Exact tenant catalog name is the safest compatibility bridge for custom
    // services created after the old enum-based UI was introduced.
    const exactCatalogs = await prisma.serviceCatalog.findMany({
        where: {
            adminId,
            status: ServiceStatus.ACTIVE,
            serviceName: { equals: serviceName, mode: "insensitive" },
        },
        orderBy: { createdAt: "asc" },
        take: 2,
        select: {
            id: true,
            serviceName: true,
            basePrice: true,
            duration: true,
            legacyServiceType: true,
        },
    });
    if (exactCatalogs.length === 1) {
        const catalog = exactCatalogs[0];
        return {
            serviceCatalogId: catalog.id,
            serviceType: catalog.legacyServiceType ?? null,
            serviceNameSnapshot: catalog.serviceName,
            priceSnapshot: catalog.basePrice,
            durationSnapshot: catalog.duration,
        };
    }

    const inferred = inferLegacyServiceType(serviceName);
    if (inferred) {
        const resolved = await resolveServiceIdentity(adminId, { serviceType: inferred });
        return {
            ...resolved,
            // Preserve the original display label when there was no
            // unambiguous catalog row to snapshot.
            serviceNameSnapshot: resolved.serviceCatalogId
                ? resolved.serviceNameSnapshot
                : serviceName,
        };
    }

    // Unknown free text remains readable for historical/rolling clients but is
    // never guessed into another catalog identity.
    return {
        serviceCatalogId: null,
        serviceType: null,
        serviceNameSnapshot: serviceName,
        priceSnapshot: null,
        durationSnapshot: null,
    };
};
