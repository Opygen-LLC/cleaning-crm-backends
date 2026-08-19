import { ServiceStatus, ServiceType } from "../../generated/prisma/enums";

export interface IServiceAddOn {
    name: string;
    price: number;
}

export interface IServiceCatalogCreate {
    serviceName: string;
    description: string;
    basePrice: number;
    duration: string;
    category: string;
    status?: ServiceStatus;
    onlineBookingEnabled?: boolean;
    addOns?: IServiceAddOn[];
    legacyServiceType?: ServiceType | null;
}

export interface IServiceCatalogUpdate {
    serviceName?: string;
    description?: string;
    basePrice?: number;
    duration?: string;
    category?: string;
    status?: ServiceStatus;
    onlineBookingEnabled?: boolean;
    addOns?: IServiceAddOn[];
    legacyServiceType?: ServiceType | null;
}

export interface IServiceCatalogFilters {
    searchTerm?: string;
    category?: string;
    status?: ServiceStatus;
}
