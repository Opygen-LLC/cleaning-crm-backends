import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import { ServiceType } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import {
    IPricingRulesUpsert,
    IPricingRule,
    IAddOnRule,
} from "./pricingRules.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Default pricing rules shown the first time an admin opens the page
const DEFAULT_RULES: Omit<IPricingRule, "id">[] = [
    {
        service: ServiceType.RESIDENTIAL_CLEAN,
        baseRate: 85,
        perRoomRate: 20,
        minCharge: 60,
        travelSurcharge: 10,
    },
    {
        service: ServiceType.DEEP_CLEAN,
        baseRate: 175,
        perRoomRate: 40,
        minCharge: 100,
        travelSurcharge: 10,
    },
    {
        service: ServiceType.OFFICE_CLEAN,
        baseRate: 65,
        perRoomRate: 15,
        minCharge: 55,
        travelSurcharge: 0,
    },
    {
        service: ServiceType.END_OF_TENANCY,
        baseRate: 195,
        perRoomRate: 45,
        minCharge: 140,
        travelSurcharge: 15,
    },
    {
        service: ServiceType.CARPET_CLEAN,
        baseRate: 45,
        perRoomRate: 45,
        minCharge: 40,
        travelSurcharge: 5,
    },
    {
        service: ServiceType.WINDOW_CLEAN,
        baseRate: 45,
        perRoomRate: 0,
        minCharge: 35,
        travelSurcharge: 5,
    },
    {
        service: ServiceType.MOVE_IN_OUT_CLEAN,
        baseRate: 155,
        perRoomRate: 30,
        minCharge: 100,
        travelSurcharge: 10,
    },
];

const DEFAULT_ADDONS: Omit<IAddOnRule, "id">[] = [
    { label: "Oven & hob deep clean", price: 40 },
    { label: "Fridge / freezer clean", price: 20 },
    { label: "Carpet steam clean", price: 45 },
    { label: "Window internal clean", price: 30 },
];

const seedDefaults = () => ({
    rules: DEFAULT_RULES.map((r, i) => ({ ...r, id: `default-${i}` })),
    addons: DEFAULT_ADDONS.map((a, i) => ({ ...a, id: `addon-default-${i}` })),
});

// ─── GET ──────────────────────────────────────────────────────────────────────

/**
 * Returns pricing rules for the authenticated admin.
 * If no record exists yet, returns seeded defaults (not persisted until admin saves).
 */
const getPricingRules = async (user: IRequestUser) => {
    const adminId = await getAdminId(user);

    const record = await prisma.pricingRules.findUnique({ where: { adminId } });

    if (!record) {
        return seedDefaults();
    }

    return {
        rules: record.rules as unknown as IPricingRule[],
        addons: record.addons as unknown as IAddOnRule[],
    };
};

// ─── UPSERT ───────────────────────────────────────────────────────────────────

/**
 * Creates or replaces the full pricing rule set for the authenticated admin.
 */
const upsertPricingRules = async (
    payload: IPricingRulesUpsert,
    user: IRequestUser,
) => {
    const adminId = await getAdminId(user);

    // Validate service types
    const validServices = Object.values(ServiceType) as string[];
    for (const rule of payload.rules) {
        if (!validServices.includes(rule.service)) {
            throw new AppError(
                status.BAD_REQUEST,
                `Invalid service type: ${rule.service}`,
            );
        }
        if (
            rule.baseRate < 0 ||
            rule.minCharge < 0 ||
            rule.perRoomRate < 0 ||
            rule.travelSurcharge < 0
        ) {
            throw new AppError(
                status.BAD_REQUEST,
                "Rate values cannot be negative",
            );
        }
    }

    for (const addon of payload.addons) {
        if (!addon.label.trim()) {
            throw new AppError(
                status.BAD_REQUEST,
                "Add-on label cannot be empty",
            );
        }
        if (addon.price < 0) {
            throw new AppError(
                status.BAD_REQUEST,
                "Add-on price cannot be negative",
            );
        }
    }

    // Ensure stable IDs
    const addonsWithIds: IAddOnRule[] = payload.addons.map((a, i) => ({
        ...a,
        id: a.id || `addon-${adminId.slice(0, 6)}-${i}-${Date.now()}`,
    }));

    const rulesWithIds: IPricingRule[] = payload.rules.map((r, i) => ({
        ...r,
        id: r.id || `rule-${adminId.slice(0, 6)}-${i}`,
    }));

    const saved = await prisma.pricingRules.upsert({
        where: { adminId },
        create: {
            adminId,
            rules: rulesWithIds as object[],
            addons: addonsWithIds as object[],
        },
        update: {
            rules: rulesWithIds as object[],
            addons: addonsWithIds as object[],
            updatedAt: new Date(),
        },
    });

    return {
        rules: saved.rules as unknown as IPricingRule[],
        addons: saved.addons as unknown as IAddOnRule[],
    };
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const pricingRulesService = {
    getPricingRules,
    upsertPricingRules,
};
