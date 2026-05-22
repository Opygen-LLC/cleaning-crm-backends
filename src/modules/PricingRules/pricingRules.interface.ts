import { ServiceType } from "../../generated/prisma/enums";

export interface IPricingRule {
    id: string;
    service: ServiceType;
    baseRate: number;
    perRoomRate: number;
    minCharge: number;
    travelSurcharge: number;
}

export interface IAddOnRule {
    id: string;
    label: string;
    price: number;
}

export interface IPricingRulesUpsert {
    rules: IPricingRule[];
    addons: IAddOnRule[];
}
