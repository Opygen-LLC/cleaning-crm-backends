export interface createClientPayload {
  name: string;
  email: string;
  phone: string;
  servicePreference?: string;

  addressLine1: string;
  addressLine2?: string;
  city: string;
  zipcode: string;
  country: string;

  totalBookings?: number;
  totalSpend?: number;

  notes?: string;
}

export interface updateClientPayload {
  name?: string;
  phone?: string;
  servicePreference?: string;
  status?: "ACTIVE" | "INACTIVE" | "BLOCKED";

  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  zipcode?: string;
  country?: string;

  totalBookings?: number;
  totalSpend?: number;
}
