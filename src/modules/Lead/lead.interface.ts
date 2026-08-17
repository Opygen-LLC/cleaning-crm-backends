export interface CreateLeadPayload {
    name: string;
    email: string;
    phone?: string;
    serviceInterest: string;
    estimatedMin?: number;
    estimatedMax?: number;
    notes?: string;
    sourceRef?: string;
    serviceCatalogId?: string;
}

export interface UpdateLeadPayload {
    name?: string;
    email?: string;
    phone?: string;
    serviceInterest?: string;
    estimatedMin?: number;
    estimatedMax?: number;
    notes?: string;
    sourceRef?: string;
    serviceCatalogId?: string;
}
