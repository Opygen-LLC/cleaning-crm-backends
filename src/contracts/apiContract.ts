import { z } from "zod";
import {
  AccountStatus,
  BookingStatus,
  Currency,
  InvoiceStatus,
  LeadStage,
  PaymentStatus,
  QuoteStatus,
  ServiceType,
  StaffStatus,
  SubscriptionName,
  SubscriptionStatus,
  UserRole,
  WebsiteStatus,
  WebsiteDomainStatus,
} from "../generated/prisma/client";

/**
 * Canonical server wire contract. Values are sourced from generated Prisma
 * enums so transport validation and persistence cannot drift independently.
 */
export const API_CONTRACT = {
  userRole: Object.values(UserRole),
  accountStatus: Object.values(AccountStatus),
  currency: Object.values(Currency),
  bookingStatus: Object.values(BookingStatus),
  invoiceStatus: Object.values(InvoiceStatus),
  quoteStatus: Object.values(QuoteStatus),
  staffStatus: Object.values(StaffStatus),
  leadStage: Object.values(LeadStage),
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
  onboardingStep: ["business_profile", "branding", "services", "website_address", "review_launch"] as const,
  serviceType: Object.values(ServiceType),
  subscriptionName: Object.values(SubscriptionName),
  subscriptionStatus: Object.values(SubscriptionStatus),
  paymentStatus: Object.values(PaymentStatus),
} as const;


export const API_SCHEMA = {
  userRole: z.nativeEnum(UserRole),
  accountStatus: z.nativeEnum(AccountStatus),
  currency: z.nativeEnum(Currency),
  bookingStatus: z.nativeEnum(BookingStatus),
  invoiceStatus: z.nativeEnum(InvoiceStatus),
  quoteStatus: z.nativeEnum(QuoteStatus),
  staffStatus: z.nativeEnum(StaffStatus),
  leadStage: z.nativeEnum(LeadStage),
  websiteStatus: z.nativeEnum(WebsiteStatus),
  websiteDomainStatus: z.nativeEnum(WebsiteDomainStatus),
  domainLifecycleStatus: z.enum(API_CONTRACT.domainLifecycleStatus),
  onboardingStep: z.enum(API_CONTRACT.onboardingStep),
  serviceType: z.nativeEnum(ServiceType),
  subscriptionName: z.nativeEnum(SubscriptionName),
  subscriptionStatus: z.nativeEnum(SubscriptionStatus),
  paymentStatus: z.nativeEnum(PaymentStatus),
} as const;

export type UserRoleApi = UserRole;
export type AccountStatusApi = AccountStatus;
export type CurrencyApi = Currency;
export type BookingStatusApi = BookingStatus;
export type InvoiceStatusApi = InvoiceStatus;
export type QuoteStatusApi = QuoteStatus;
export type StaffStatusApi = StaffStatus;
export type LeadStageApi = LeadStage;
export type WebsiteStatusApi = WebsiteStatus;
export type WebsiteDomainStatusApi = WebsiteDomainStatus;
export type DomainLifecycleStatusApi = (typeof API_CONTRACT.domainLifecycleStatus)[number];
export type OnboardingStepApi = (typeof API_CONTRACT.onboardingStep)[number];
export type ServiceTypeApi = ServiceType;
export type SubscriptionNameApi = SubscriptionName;
export type SubscriptionApiStatus = SubscriptionStatus;
export type PaymentStatusApi = PaymentStatus;
