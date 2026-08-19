export interface IPricingRule {
    id: string;
    serviceCatalogId: string;
    serviceNameSnapshot: string;
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
