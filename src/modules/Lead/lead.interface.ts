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
  stage?: "NEW" | "CONTACTED" | "QUOTE_SENT" | "WON" | "LOST";
  initialFollowUp?: {
    scheduledAt: string;
    assignedToUserId?: string;
    note?: string;
  };
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
