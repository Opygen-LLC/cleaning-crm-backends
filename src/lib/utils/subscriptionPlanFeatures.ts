export interface SubscriptionPlanFeature {
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

        return { label: trimmed, included: true };
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!label) return null;

    const limit = typeof record.limit === "string" ? record.limit.trim() : "";

    return {
        label,
        included:
            typeof record.included === "boolean" ? record.included : true,
        ...(limit ? { limit } : {}),
    };
}

/**
 * Converts both the old TEXT[] representation (plain strings or JSON-encoded
 * strings) and the current JSON representation into one canonical structure.
 * The de-duplication key is case/punctuation-insensitive, matching the feature
 * gate's comparison semantics.
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

        const key = feature.label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
        if (!key) continue;

        const existingIndex = indexByKey.get(key);
        if (existingIndex === undefined) {
            indexByKey.set(key, result.length);
            result.push(feature);
        } else {
            // The last submitted row wins. This makes editor retries and
            // migration of duplicated legacy labels deterministic.
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
