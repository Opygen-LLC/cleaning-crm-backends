import { z } from "zod";
import {
  AccountStatus,
  BookingStatus,
  Currency,
  InvoiceStatus,
  PaymentStatus,
  QuoteStatus,
  ServiceType,
  StaffStatus,
  SubscriptionStatus,
  WebsiteStatus,
  WebsiteDomainStatus,
} from "../generated/prisma/client";

/**
 * Canonical server wire contract. Values are sourced from generated Prisma
 * enums so transport validation and persistence cannot drift independently.
 */
export const API_CONTRACT = {
  currency: Object.values(Currency),
  bookingStatus: Object.values(BookingStatus),
  invoiceStatus: Object.values(InvoiceStatus),
  quoteStatus: Object.values(QuoteStatus),
  staffStatus: Object.values(StaffStatus),
  accountStatus: Object.values(AccountStatus),
  websiteStatus: Object.values(WebsiteStatus),
  websiteDomainStatus: Object.values(WebsiteDomainStatus),
  domainLifecycleStatus: [
    "PENDING_VERIFICATION",
    "OWNERSHIP_VERIFIED",
    "DNS_PENDING",
    "SSL_PROVISIONING",
    "ACTIVE",
    "FAILED",
  ] as const,
  onboardingStep: ["business_profile", "branding", "services", "website_address", "template"] as const,
  serviceType: Object.values(ServiceType),
  subscriptionStatus: Object.values(SubscriptionStatus),
  paymentStatus: Object.values(PaymentStatus),
} as const;


export const API_SCHEMA = {
  currency: z.nativeEnum(Currency),
  bookingStatus: z.nativeEnum(BookingStatus),
  invoiceStatus: z.nativeEnum(InvoiceStatus),
  quoteStatus: z.nativeEnum(QuoteStatus),
  staffStatus: z.nativeEnum(StaffStatus),
  accountStatus: z.nativeEnum(AccountStatus),
  websiteStatus: z.nativeEnum(WebsiteStatus),
  websiteDomainStatus: z.nativeEnum(WebsiteDomainStatus),
  domainLifecycleStatus: z.enum(API_CONTRACT.domainLifecycleStatus),
  onboardingStep: z.enum(API_CONTRACT.onboardingStep),
  serviceType: z.nativeEnum(ServiceType),
  subscriptionStatus: z.nativeEnum(SubscriptionStatus),
  paymentStatus: z.nativeEnum(PaymentStatus),
} as const;

export type CurrencyApi = Currency;
export type BookingStatusApi = BookingStatus;
export type InvoiceStatusApi = InvoiceStatus;
export type QuoteStatusApi = QuoteStatus;
export type StaffStatusApi = StaffStatus;
export type AccountStatusApi = AccountStatus;
export type WebsiteStatusApi = WebsiteStatus;
export type WebsiteDomainStatusApi = WebsiteDomainStatus;
export type DomainLifecycleStatusApi = (typeof API_CONTRACT.domainLifecycleStatus)[number];
export type OnboardingStepApi = (typeof API_CONTRACT.onboardingStep)[number];
export type ServiceTypeApi = ServiceType;
export type SubscriptionApiStatus = SubscriptionStatus;
export type PaymentStatusApi = PaymentStatus;
