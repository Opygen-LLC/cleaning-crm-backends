import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { ServiceType } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import {
    IPricingRulesUpsert,
    IPricingRule,
    IAddOnRule,
} from "./pricingRules.interface";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const resolveAdminId = async (userId: string): Promise<string> => {
    const admin = await prisma.adminProfile.findUnique({ where: { userId } });
    if (!admin) throw new AppError(status.NOT_FOUND, "Admin profile not found");
    return admin.id;
};

// Default pricing rules seeded when none exist for an admin
const DEFAULT_RULES: Omit<IPricingRule, "id">[] = [
    { service: ServiceType.RESIDENTIAL_CLEAN, baseRate: 85,  perRoomRate: 20, minCharge: 60,  travelSurcharge: 10 },
    { service: ServiceType.DEEP_CLEAN,        baseRate: 175, perRoomRate: 40, minCharge: 100, travelSurcharge: 10 },
    { service: ServiceType.OFFICE_CLEAN,      baseRate: 65,  perRoomRate: 15, minCharge: 55,  travelSurcharge: 0  },
    { service: ServiceType.END_OF_TENANCY,    baseRate: 195, perRoomRate: 45, minCharge: 140, travelSurcharge: 15 },
    { service: ServiceType.CARPET_CLEAN,      baseRate: 45,  perRoomRate: 45, minCharge: 40,  travelSurcharge: 5  },
    { service: ServiceType.WINDOW_CLEAN,      baseRate: 45,  perRoomRate: 0,  minCharge: 35,  travelSurcharge: 5  },
    { service: ServiceType.MOVE_IN_OUT_CLEAN, baseRate: 155, perRoomRate: 30, minCharge: 100, travelSurcharge: 10 },
];

const DEFAULT_ADDONS: Omit<IAddOnRule, "id">[] = [
    { label: "Oven & hob deep clean",  price: 40 },
    { label: "Fridge / freezer clean", price: 20 },
    { label: "Carpet steam clean",     price: 45 },
    { label: "Window internal clean",  price: 30 },
];

const seedDefaults = () => ({
    rules: DEFAULT_RULES.map((r, i) => ({ ...r, id: `default-${i}` })),
    addons: DEFAULT_ADDONS.map((a, i) => ({ ...a, id: `addon-default-${i}` })),
});

// ─── GET ──────────────────────────────────────────────────────────────────────

/**
 * Retrieves pricing rules for the authenticated admin.
 * Pricing rules are stored as JSON in a dedicated PricingRules table keyed by adminId.
 * If no record exists, returns seeded defaults (not persisted until the admin saves).
 */
const getPricingRules = async (user: IRequestUser) => {
    const adminId = await resolveAdminId(user.id);

    const record = await (prisma as any).pricingRules?.findUnique?.({ where: { adminId } })
        ?? null;

    if (!record) {
        // Return defaults without persisting — admin sees pre-filled form
        return seedDefaults();
    }

    return {
        rules:  record.rules  as IPricingRule[],
        addons: record.addons as IAddOnRule[],
    };
};

// ─── UPSERT ───────────────────────────────────────────────────────────────────

/**
 * Creates or updates pricing rules for the authenticated admin.
 * Validates that every serviceRule has a valid ServiceType enum value.
 */
const upsertPricingRules = async (
    payload: IPricingRulesUpsert,
    user: IRequestUser,
) => {
    const adminId = await resolveAdminId(user.id);

    // Validate service types
    const validServices = Object.values(ServiceType) as string[];
    for (const rule of payload.rules) {
        if (!validServices.includes(rule.service)) {
            throw new AppError(
                status.BAD_REQUEST,
                `Invalid service type: ${rule.service}`,
            );
        }
        if (rule.baseRate < 0 || rule.minCharge < 0 || rule.perRoomRate < 0 || rule.travelSurcharge < 0) {
            throw new AppError(status.BAD_REQUEST, "Rate values cannot be negative");
        }
    }

    for (const addon of payload.addons) {
        if (!addon.label.trim()) {
            throw new AppError(status.BAD_REQUEST, "Add-on label cannot be empty");
        }
        if (addon.price < 0) {
            throw new AppError(status.BAD_REQUEST, "Add-on price cannot be negative");
        }
    }

    // Ensure each addon has a stable ID
    const addonsWithIds: IAddOnRule[] = payload.addons.map((a, i) => ({
        ...a,
        id: a.id || `addon-${adminId.slice(0, 6)}-${i}-${Date.now()}`,
    }));

    const rulesWithIds: IPricingRule[] = payload.rules.map((r, i) => ({
        ...r,
        id: r.id || `rule-${adminId.slice(0, 6)}-${i}`,
    }));

    // Upsert into pricingRules table
    const saved = await (prisma as any).pricingRules.upsert({
        where:  { adminId },
        create: { adminId, rules: rulesWithIds, addons: addonsWithIds },
        update: { rules: rulesWithIds, addons: addonsWithIds, updatedAt: new Date() },
    });

    return {
        rules:  saved.rules  as IPricingRule[],
        addons: saved.addons as IAddOnRule[],
    };
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const pricingRulesService = {
    getPricingRules,
    upsertPricingRules,
};
