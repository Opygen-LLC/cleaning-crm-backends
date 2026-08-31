export const BUSINESS_NOTIFICATION_TEMPLATE_KEYS = [
  "booking-confirmation",
  "booking-reminder-24h",
  "booking-reminder-day-of",
  "staff-assigned",
  "quote-sent",
  "estimate-sent",
  "invoice-sent",
  "invoice-due",
  "review-request",
] as const;

export type BusinessNotificationTemplateKey = (typeof BUSINESS_NOTIFICATION_TEMPLATE_KEYS)[number];
export type BusinessNotificationRecipient = "CLIENT" | "STAFF";
export type BusinessNotificationTiming = "IMMEDIATE" | "24_HOURS_BEFORE" | "DAY_OF" | "WHEN_DUE";

export interface BusinessNotificationDefinition {
  key: BusinessNotificationTemplateKey;
  event: string;
  recipient: BusinessNotificationRecipient;
  preferenceKey:
    | "emailNewBooking"
    | "emailBookingReminder"
    | "emailBookingDayOfReminder"
    | "emailStaffAssigned"
    | "emailQuoteSent"
    | "emailEstimateSent"
    | "emailInvoiceSent"
    | "emailInvoiceOverdue"
    | "emailReviewRequest";
  availableVariables: readonly string[];
  defaultSubject: string;
  defaultBody: string;
  timing: BusinessNotificationTiming;
  maxAttempts: number;
  defaultEnabled: boolean;
}

const bookingVars = ["client_name", "booking_ref", "booking_date", "booking_time", "service_type", "address", "business_name"] as const;

export const BUSINESS_NOTIFICATION_REGISTRY: Record<BusinessNotificationTemplateKey, BusinessNotificationDefinition> = {
  "booking-confirmation": {
    key: "booking-confirmation", event: "BOOKING_CONFIRMED", recipient: "CLIENT", preferenceKey: "emailNewBooking",
    availableVariables: bookingVars,
    defaultSubject: "Your booking is confirmed — {{business_name}}",
    defaultBody: `Hi {{client_name}},\n\nGreat news! Your {{service_type}} has been confirmed.\n\nBooking: {{booking_ref}}\nDate: {{booking_date}}\nTime: {{booking_time}}\nAddress: {{address}}\n\nIf you need to make any changes, please contact us as soon as possible.\n\nThanks,\n{{business_name}}`,
    timing: "IMMEDIATE", maxAttempts: 8, defaultEnabled: true,
  },
  "booking-reminder-24h": {
    key: "booking-reminder-24h", event: "BOOKING_REMINDER_24H", recipient: "CLIENT", preferenceKey: "emailBookingReminder",
    availableVariables: bookingVars,
    defaultSubject: "Reminder: Your clean is tomorrow — {{business_name}}",
    defaultBody: `Hi {{client_name}},\n\nJust a friendly reminder that your {{service_type}} is scheduled soon.\n\nBooking: {{booking_ref}}\nDate: {{booking_date}}\nTime: {{booking_time}}\nAddress: {{address}}\n\nIf anything has changed, please let us know.\n\nSee you soon!\n{{business_name}}`,
    timing: "24_HOURS_BEFORE", maxAttempts: 8, defaultEnabled: true,
  },
  "booking-reminder-day-of": {
    key: "booking-reminder-day-of", event: "BOOKING_REMINDER_DAY_OF", recipient: "CLIENT", preferenceKey: "emailBookingDayOfReminder",
    availableVariables: bookingVars,
    defaultSubject: "Your cleaning is today — {{business_name}}",
    defaultBody: `Hi {{client_name}},\n\nYour {{service_type}} is scheduled for today.\n\nBooking: {{booking_ref}}\nDate: {{booking_date}}\nTime: {{booking_time}}\nAddress: {{address}}\n\nWe look forward to seeing you.\n\n{{business_name}}`,
    timing: "DAY_OF", maxAttempts: 8, defaultEnabled: false,
  },
  "staff-assigned": {
    key: "staff-assigned", event: "STAFF_ASSIGNED", recipient: "STAFF", preferenceKey: "emailStaffAssigned",
    availableVariables: ["staff_name", "job_ref", "client_name", "service_type", "booking_date", "booking_time", "address", "job_link", "business_name"],
    defaultSubject: "New job assigned — {{job_ref}}",
    defaultBody: `Hi {{staff_name}},\n\nYou have been assigned to a new job.\n\nClient: {{client_name}}\nService: {{service_type}}\nDate: {{booking_date}}\nTime: {{booking_time}}\nAddress: {{address}}\n\nView job: {{job_link}}\n\n{{business_name}}`,
    timing: "IMMEDIATE", maxAttempts: 8, defaultEnabled: false,
  },
  "quote-sent": {
    key: "quote-sent", event: "QUOTE_SENT", recipient: "CLIENT", preferenceKey: "emailQuoteSent",
    availableVariables: ["client_name", "quote_ref", "service_type", "quote_total", "valid_until", "quote_link", "business_name"],
    defaultSubject: "Your quote from {{business_name}}",
    defaultBody: `Hi {{client_name}},\n\nThank you for your enquiry. Your quote {{quote_ref}} for {{service_type}} is ready.\n\nTotal: {{quote_total}}\nValid until: {{valid_until}}\n\nView and accept your quote: {{quote_link}}\n\nIf you have any questions, please get in touch.\n\n{{business_name}}`,
    timing: "IMMEDIATE", maxAttempts: 8, defaultEnabled: true,
  },
  "estimate-sent": {
    key: "estimate-sent", event: "ESTIMATE_SENT", recipient: "CLIENT", preferenceKey: "emailEstimateSent",
    availableVariables: ["client_name", "estimate_ref", "service_type", "estimate_total", "valid_until", "estimate_link", "business_name"],
    defaultSubject: "Your estimate from {{business_name}}",
    defaultBody: `Hi {{client_name}},\n\nYour estimate {{estimate_ref}} for {{service_type}} is ready.\n\nEstimated total: {{estimate_total}}\nValid until: {{valid_until}}\n\nView and respond to your estimate: {{estimate_link}}\n\nIf you have any questions, please get in touch.\n\n{{business_name}}`,
    timing: "IMMEDIATE", maxAttempts: 8, defaultEnabled: true,
  },
  "invoice-sent": {
    key: "invoice-sent", event: "INVOICE_SENT", recipient: "CLIENT", preferenceKey: "emailInvoiceSent",
    availableVariables: ["client_name", "invoice_ref", "service_type", "invoice_amount", "due_date", "invoice_link", "business_name"],
    defaultSubject: "Invoice {{invoice_ref}} from {{business_name}}",
    defaultBody: `Hi {{client_name}},\n\nYour invoice {{invoice_ref}} is ready.\n\nAmount due: {{invoice_amount}}\nDue date: {{due_date}}\n\nView invoice: {{invoice_link}}\n\nThank you,\n{{business_name}}`,
    timing: "IMMEDIATE", maxAttempts: 8, defaultEnabled: true,
  },
  "invoice-due": {
    key: "invoice-due", event: "INVOICE_DUE", recipient: "CLIENT", preferenceKey: "emailInvoiceOverdue",
    availableVariables: ["client_name", "invoice_ref", "service_type", "invoice_amount", "due_date", "invoice_link", "business_name"],
    defaultSubject: "Invoice due — {{invoice_amount}} outstanding",
    defaultBody: `Hi {{client_name}},\n\nThis is a reminder that invoice {{invoice_ref}} is due on {{due_date}}.\n\nAmount due: {{invoice_amount}}\n\nView invoice: {{invoice_link}}\n\nIf you have already paid, please disregard this message.\n\n{{business_name}}`,
    timing: "WHEN_DUE", maxAttempts: 8, defaultEnabled: true,
  },
  "review-request": {
    key: "review-request", event: "REVIEW_REQUEST", recipient: "CLIENT", preferenceKey: "emailReviewRequest",
    availableVariables: ["client_name", "job_ref", "service_type", "completed_date", "staff_name", "review_link", "business_name"],
    defaultSubject: "How did we do? — {{business_name}}",
    defaultBody: `Hi {{client_name}},\n\nThank you for choosing {{business_name}} for your {{service_type}}. We would love to hear your feedback.\n\nLeave a review: {{review_link}}\n\nThanks,\n{{business_name}}`,
    timing: "IMMEDIATE", maxAttempts: 8, defaultEnabled: true,
  },
};

export const isBusinessNotificationTemplateKey = (value: string): value is BusinessNotificationTemplateKey =>
  BUSINESS_NOTIFICATION_TEMPLATE_KEYS.includes(value as BusinessNotificationTemplateKey);

export const getBusinessNotificationDefinition = (key: BusinessNotificationTemplateKey) => BUSINESS_NOTIFICATION_REGISTRY[key];
