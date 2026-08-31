export interface UpdateNotificationPrefsPayload {
  emailNewBooking?: boolean;
  emailBookingCancelled?: boolean;
  emailBookingReminder?: boolean;
  emailBookingDayOfReminder?: boolean;
  emailQuoteAccepted?: boolean;
  emailQuoteDeclined?: boolean;
  emailInvoicePaid?: boolean;
  emailInvoiceOverdue?: boolean;
  emailNewClient?: boolean;
  emailStaffAssigned?: boolean;
  emailQuoteSent?: boolean;
  emailInvoiceSent?: boolean;
  emailReviewRequest?: boolean;
  emailWeeklySummary?: boolean;
  appNewBooking?: boolean;
  appJobStatusChange?: boolean;
  appQuoteUpdate?: boolean;
  appInvoiceUpdate?: boolean;
  appClientMessage?: boolean;
  smsBookingReminder?: boolean;
  smsJobAssigned?: boolean;
  reminderHoursBefore?: number;
  digestTime?: string;
}

export interface UpsertNotificationTemplatePayload {
  subject?: string;
  body: string;
  channel?: "EMAIL";
}
