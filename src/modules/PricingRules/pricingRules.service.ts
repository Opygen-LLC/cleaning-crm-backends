import { prisma } from "../../lib/prisma/prisma";
import AppError from "../../errorHelper/AppError";
import { getAdminId } from "../../lib/utils/resolveAdminId";
import status from "http-status";
import { ServiceStatus } from "../../generated/prisma/enums";
import { IRequestUser } from "../../types/requestUser.interface";
import { IPricingRulesUpsert, IPricingRule, IAddOnRule } from "./pricingRules.interface";

const DEFAULT_ADDONS: Omit<IAddOnRule, "id">[] = [
    { label: "Oven & hob deep clean", price: 40 },
    { label: "Fridge / freezer clean", price: 20 },
    { label: "Carpet steam clean", price: 45 },
    { label: "Window internal clean", price: 30 },
];

type LegacyRule = Partial<IPricingRule> & { service?: string };

const getCatalog = (adminId: string) => prisma.serviceCatalog.findMany({
    where: { adminId, status: ServiceStatus.ACTIVE },
    orderBy: [{ category: "asc" }, { serviceName: "asc" }],
    select: { id: true, serviceName: true, basePrice: true, legacyServiceType: true },
});

/**
 * Materialise one canonical rule per active tenant service. Historical JSON
 * rules keyed by ServiceType are bridged only when the catalog mapping is
 * unambiguous; custom catalog services are never guessed into a legacy type.
 */
const normalizeRules = (
    adminId: string,
    catalogs: Awaited<ReturnType<typeof getCatalog>>,
    rawRules: LegacyRule[],
): IPricingRule[] => {
    return catalogs.map((catalog, index) => {
        const canonical = rawRules.find((rule) => rule.serviceCatalogId === catalog.id);
        const legacyMatches = catalog.legacyServiceType
            ? rawRules.filter((rule) => !rule.serviceCatalogId && rule.service === catalog.legacyServiceType)
            : [];
        const source = canonical ?? (legacyMatches.length === 1 ? legacyMatches[0] : undefined);
        const base = Number(source?.baseRate ?? catalog.basePrice ?? 0);
        return {
            id: source?.id || `rule-${adminId.slice(0, 6)}-${index}-${catalog.id.slice(0, 6)}`,
            serviceCatalogId: catalog.id,
            serviceNameSnapshot: catalog.serviceName,
            baseRate: base,
            perRoomRate: Number(source?.perRoomRate ?? 0),
            minCharge: Number(source?.minCharge ?? base),
            travelSurcharge: Number(source?.travelSurcharge ?? 0),
        };
    });
};

const getPricingRules = async (user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const [record, catalogs] = await Promise.all([
        prisma.pricingRules.findUnique({ where: { adminId } }),
        getCatalog(adminId),
    ]);

    const rawRules = Array.isArray(record?.rules) ? (record!.rules as unknown as LegacyRule[]) : [];
    const addons = Array.isArray(record?.addons)
        ? (record!.addons as unknown as IAddOnRule[])
        : DEFAULT_ADDONS.map((item, index) => ({ ...item, id: `addon-default-${index}` }));

    return { rules: normalizeRules(adminId, catalogs, rawRules), addons };
};

const upsertPricingRules = async (payload: IPricingRulesUpsert, user: IRequestUser) => {
    const adminId = await getAdminId(user);
    const catalogs = await getCatalog(adminId);
    const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));

    const seen = new Set<string>();
    const rulesWithIds: IPricingRule[] = payload.rules.map((rule, index) => {
        const catalog = catalogById.get(rule.serviceCatalogId);
        if (!catalog) {
            throw new AppError(status.UNPROCESSABLE_ENTITY, "One or more pricing rules reference an unavailable service", {
                code: "SERVICE_NOT_AVAILABLE",
                retryable: false,
                fieldErrors: { serviceCatalogId: "Choose an active service from this business." },
            });
        }
        if (seen.has(catalog.id)) {
            throw new AppError(status.BAD_REQUEST, `Duplicate pricing rule for ${catalog.serviceName}`);
        }
        seen.add(catalog.id);
        return {
            ...rule,
            id: rule.id || `rule-${adminId.slice(0, 6)}-${index}-${catalog.id.slice(0, 6)}`,
            serviceNameSnapshot: catalog.serviceName,
        };
    });

    const addonsWithIds: IAddOnRule[] = payload.addons.map((addon, index) => ({
        ...addon,
        label: addon.label.trim(),
        id: addon.id || `addon-${adminId.slice(0, 6)}-${index}-${Date.now()}`,
    }));

    const saved = await prisma.pricingRules.upsert({
        where: { adminId },
        create: { adminId, rules: rulesWithIds as object[], addons: addonsWithIds as object[] },
        update: { rules: rulesWithIds as object[], addons: addonsWithIds as object[], updatedAt: new Date() },
    });

    return {
        rules: saved.rules as unknown as IPricingRule[],
        addons: saved.addons as unknown as IAddOnRule[],
    };
};

export const pricingRulesService = { getPricingRules, upsertPricingRules };
