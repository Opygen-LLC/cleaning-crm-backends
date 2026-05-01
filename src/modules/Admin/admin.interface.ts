import { Currency } from "../../generated/prisma/enums";

export interface UpdateAdminPayload {
    businessName?: string;
	businessLogo?: string;
    businessType?: string;
    businessEmail?: string;
    website?: string;
    brandColor?: string;
    currency?: Currency;
    mobileNumber?: string;

    address?: string;
    city?: string;
    zipcode?: string;
    country?: string;

    workLocations?: {
        city: string;
        postcode?: string;
        notes?: string;
    }[];
}
