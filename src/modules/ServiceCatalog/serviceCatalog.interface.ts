import { ServiceStatus } from "../../generated/prisma/enums";

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
}

export interface IServiceCatalogUpdate {
    serviceName?: string;
    description?: string;
    basePriceGbp?: number;
    duration?: string;
    category?: string;
    status?: ServiceStatus;
    addOns?: IServiceAddOn[];
}

export interface IServiceCatalogFilters {
    searchTerm?: string;
    category?: string;
    status?: ServiceStatus;
    adminId?: string;
}
