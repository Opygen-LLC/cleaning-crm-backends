import { ServiceCategory, ServiceStatus, ServiceType } from "../../generated/prisma/enums";

export interface IServiceAddOn {
    name: string;
    price: number;
}

export interface IServiceCatalogCreate {
    serviceName: string;
    description: string;
    basePrice: number;
    duration: string;
    category: ServiceCategory;
    status?: ServiceStatus;
    onlineBookingEnabled?: boolean;
    addOns?: IServiceAddOn[];
    legacyServiceType?: ServiceType | null;
}

export interface IServiceCatalogSync extends IServiceCatalogCreate {
    /** Stable identity used by onboarding updates. Omit for genuinely new services. */
    serviceCatalogId?: string;
}

export interface IServiceCatalogUpdate {
    serviceName?: string;
    description?: string;
    basePrice?: number;
    duration?: string;
    category?: ServiceCategory;
    status?: ServiceStatus;
    onlineBookingEnabled?: boolean;
    addOns?: IServiceAddOn[];
    legacyServiceType?: ServiceType | null;
}

export interface IServiceCatalogFilters {
    page?: number;
    limit?: number;
    searchTerm?: string;
    category?: ServiceCategory;
    status?: ServiceStatus;
}
