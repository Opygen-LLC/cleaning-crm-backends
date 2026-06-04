import { DiscountType } from "../../generated/prisma/enums";

export interface ICouponCreate {
    code:          string;
    description?:  string;
    discountType:  DiscountType;
    discountValue: number;
    maxUses?:      number | null;
    validFrom?:    string | Date | null;
    validUntil?:   string | Date | null;
    isActive?:     boolean;
}

export interface ICouponUpdate {
    code?:          string;
    description?:   string | null;
    discountType?:  DiscountType;
    discountValue?: number;
    maxUses?:       number | null;
    validFrom?:     string | Date | null;
    validUntil?:    string | Date | null;
    isActive?:      boolean;
}

export interface ICouponFilters {
    searchTerm?:   string;
    isActive?:     boolean;
    discountType?: DiscountType;
    page?:         number;
    limit?:        number;
}
