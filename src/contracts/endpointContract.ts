export type ApiRole = "PUBLIC" | "ADMIN" | "STAFF" | "SUPER_ADMIN";

export type ApiModuleContract = {
  domain: string;
  basePath: string;
  roles: readonly ApiRole[];
  requestContract: string;
  responseContract: string;
  errorContract: "TErrorResponse";
};

/**
 * Cross-repository contract boundary for the API modules used by RTK Query.
 * Endpoint-specific DTOs remain in their domain files; this matrix prevents
 * routing/auth/error-envelope drift at the module boundary.
 */
export const API_MODULE_CONTRACTS: readonly ApiModuleContract[] = [
  { domain: "Auth", basePath: "/auth", roles: ["PUBLIC", "ADMIN", "STAFF", "SUPER_ADMIN"], requestContract: "Auth DTO + Zod", responseContract: "Auth/session DTO", errorContract: "TErrorResponse" },
  { domain: "Admin", basePath: "/admin", roles: ["ADMIN"], requestContract: "Admin/onboarding DTO + Zod", responseContract: "Admin DTO", errorContract: "TErrorResponse" },
  { domain: "Clients", basePath: "/client", roles: ["ADMIN", "STAFF"], requestContract: "Client DTO + Zod", responseContract: "Client DTO", errorContract: "TErrorResponse" },
  { domain: "Staff", basePath: "/staff", roles: ["ADMIN", "STAFF"], requestContract: "Staff DTO + Zod", responseContract: "Staff DTO", errorContract: "TErrorResponse" },
  { domain: "Bookings", basePath: "/booking", roles: ["ADMIN", "STAFF"], requestContract: "Booking DTO + Zod", responseContract: "Booking DTO", errorContract: "TErrorResponse" },
  { domain: "Jobs", basePath: "/job", roles: ["ADMIN", "STAFF"], requestContract: "Job DTO + Zod", responseContract: "Job DTO", errorContract: "TErrorResponse" },
  { domain: "Leads", basePath: "/lead", roles: ["ADMIN"], requestContract: "Lead DTO + Zod", responseContract: "Lead DTO", errorContract: "TErrorResponse" },
  { domain: "Quotes", basePath: "/quote", roles: ["PUBLIC", "ADMIN"], requestContract: "Quote DTO + Zod", responseContract: "Quote DTO", errorContract: "TErrorResponse" },
  { domain: "Invoices", basePath: "/invoice", roles: ["PUBLIC", "ADMIN"], requestContract: "Invoice DTO + Zod", responseContract: "Invoice DTO", errorContract: "TErrorResponse" },
  { domain: "Payments", basePath: "/payment", roles: ["ADMIN"], requestContract: "Payment DTO + Zod", responseContract: "Payment DTO", errorContract: "TErrorResponse" },
  { domain: "Reports", basePath: "/reports", roles: ["ADMIN"], requestContract: "Report query schema", responseContract: "Report DTO", errorContract: "TErrorResponse" },
  { domain: "Notifications", basePath: "/notification", roles: ["ADMIN"], requestContract: "Notification DTO + Zod", responseContract: "Notification DTO", errorContract: "TErrorResponse" },
  { domain: "Website Studio", basePath: "/website", roles: ["PUBLIC", "ADMIN"], requestContract: "Website DTO + Zod", responseContract: "Website DTO", errorContract: "TErrorResponse" },
  { domain: "Booking forms", basePath: "/booking-form", roles: ["PUBLIC", "ADMIN"], requestContract: "Booking form DTO + Zod", responseContract: "Booking form DTO", errorContract: "TErrorResponse" },
  { domain: "Estimate forms", basePath: "/estimate-form", roles: ["PUBLIC", "ADMIN"], requestContract: "Estimate form DTO + Zod", responseContract: "Estimate form DTO", errorContract: "TErrorResponse" },
  { domain: "Subscription", basePath: "/subscription", roles: ["PUBLIC", "ADMIN", "SUPER_ADMIN"], requestContract: "Subscription DTO + Zod", responseContract: "Subscription DTO", errorContract: "TErrorResponse" },
  { domain: "Super Admin", basePath: "/super-admin", roles: ["SUPER_ADMIN"], requestContract: "Super-admin DTO + Zod", responseContract: "Super-admin DTO", errorContract: "TErrorResponse" },
] as const;
