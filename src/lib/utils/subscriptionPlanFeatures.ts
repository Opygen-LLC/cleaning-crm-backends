import {
    resolveFeatureKey,
    type FeatureKey,
} from "../../modules/Entitlement/featureCatalog";

export interface SubscriptionPlanFeature {
    /** Stable authorization key. Labels are display-only. */
    key?: FeatureKey;
    label: string;
    included: boolean;
    limit?: string;
}

function parseFeature(value: unknown): SubscriptionPlanFeature | null {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;

        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed !== value) {
                const normalized = parseFeature(parsed);
                if (normalized) return normalized;
            }
        } catch {
            // Legacy plain-string feature; treat it as included.
        }

        const key = resolveFeatureKey(trimmed) ?? undefined;
        return { ...(key ? { key } : {}), label: trimmed, included: true };
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const explicitKey = resolveFeatureKey(record.key);
    const inferredKey = explicitKey ?? resolveFeatureKey(label);
    if (!label && !inferredKey) return null;

    const limit = typeof record.limit === "string" ? record.limit.trim() : "";

    return {
        ...(inferredKey ? { key: inferredKey } : {}),
        label: label || inferredKey!,
        included:
            typeof record.included === "boolean" ? record.included : true,
        ...(limit ? { limit } : {}),
    };
}

/**
 * Converts legacy feature rows and current JSON rows into one canonical
 * structure. Known product features are de-duplicated by stable key; unknown
 * marketing-only rows remain de-duplicated by normalized label.
 */
export function normalizeSubscriptionPlanFeatures(
    raw: unknown,
): SubscriptionPlanFeature[] {
    const values = Array.isArray(raw) ? raw : [];
    const result: SubscriptionPlanFeature[] = [];
    const indexByKey = new Map<string, number>();

    for (const value of values) {
        const feature = parseFeature(value);
        if (!feature) continue;

        const key = feature.key
            ? `feature:${feature.key}`
            : `label:${feature.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
        if (!key || key === "label:") continue;

        const existingIndex = indexByKey.get(key);
        if (existingIndex === undefined) {
            indexByKey.set(key, result.length);
            result.push(feature);
        } else {
            result[existingIndex] = feature;
        }
    }

    return result;
}

export function includedSubscriptionPlanFeatureLabels(raw: unknown): string[] {
    return normalizeSubscriptionPlanFeatures(raw)
        .filter((feature) => feature.included)
        .map((feature) => feature.label);
}
