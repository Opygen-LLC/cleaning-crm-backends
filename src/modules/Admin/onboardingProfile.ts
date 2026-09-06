import { normalizeBusinessHours } from "./businessHours";
import { fingerprint } from "../ServiceCatalog/serviceCatalogConcurrency";

type ProfileSource = {
  businessName: string; businessEmail: string | null; mobileNumber: string | null;
  businessDescription: string | null; businessHours: unknown; address: string | null;
  city: string | null; zipcode: string | null; currency: string;
};

/** Shared server-side projection: bootstrap and preview must hash exactly the
 * same persisted fields, including explicit clears and normalized legacy hours. */
export const onboardingProfile = (admin: ProfileSource) => ({
  businessName: admin.businessName, businessEmail: admin.businessEmail, mobileNumber: admin.mobileNumber,
  businessDescription: admin.businessDescription, businessHours: normalizeBusinessHours(admin.businessHours),
  address: admin.address, city: admin.city, postcode: admin.zipcode, currency: admin.currency,
});
export const onboardingProfileVersion = (admin: ProfileSource) => fingerprint(onboardingProfile(admin));
