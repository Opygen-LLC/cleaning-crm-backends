import { ServiceStatus, ServiceType } from "../../generated/prisma/enums";

export interface IServiceAddOn {
    name: string;
    priceGbp: number;
}

export interface IServiceCatalogCreate {
    serviceName: string;
    description: string;
    basePriceGbp: number;
    duration: string;
    category: string;
    status?: ServiceStatus;
    addOns?: IServiceAddOn[];
    legacyServiceType?: ServiceType | null;
}

export interface IServiceCatalogUpdate {
    serviceName?: string;
    description?: string;
    basePriceGbp?: number;
    duration?: string;
    category?: string;
    status?: ServiceStatus;
    addOns?: IServiceAddOn[];
    legacyServiceType?: ServiceType | null;
}

export interface IServiceCatalogFilters {
    searchTerm?: string;
    category?: string;
    status?: ServiceStatus;
}
