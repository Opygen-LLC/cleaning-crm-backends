import { Currency } from "../../generated/prisma/enums";

export interface UpdateAdminPayload {
    businessName?: string;
	businessLogo?: string;
    brandColor?: string;
    currency?: Currency;
    mobileNumber?: string;

    address?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    country?: string;

    workLocations?: {
        city: string;
        postcode?: string;
        notes?: string;
    }[];
}
