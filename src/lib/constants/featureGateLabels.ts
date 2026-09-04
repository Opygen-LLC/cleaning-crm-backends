import { FEATURE_CATALOG, FEATURE_KEYS } from "../../modules/Entitlement/featureCatalog";

// Compatibility validator for free-form plan-editor labels. Stable feature keys
// are authoritative; these labels/aliases are derived from the canonical
// feature catalog so backend validation cannot drift from authorization.
export const CANONICAL_FEATURE_LABELS: string[] = Array.from(
    new Set(
        FEATURE_KEYS.flatMap((key) => {
            const definition = FEATURE_CATALOG[key];
            return [key, definition.label, ...definition.aliases];
        }),
    ),
);

function normalise(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const NORMALISED_CANONICAL = new Set(
    CANONICAL_FEATURE_LABELS.map((feature) => normalise(feature)),
);

function levenshtein(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
        Array(b.length + 1).fill(0),
    );
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[a.length][b.length];
}

export interface FeatureLabelWarning {
    submitted: string;
    closestCanonical: string;
    distance: number;
}

/**
 * Detect likely typos in custom/legacy labels while still allowing arbitrary
 * marketing-only plan rows. Exact labels, aliases and canonical snake-case
 * keys are accepted; authorization never depends on this fuzzy comparison.
 */
export function findNearMissFeatureLabels(labels: string[]): FeatureLabelWarning[] {
    const warnings: FeatureLabelWarning[] = [];

    for (const raw of labels) {
        const label = normalise(raw);
        if (!label || NORMALISED_CANONICAL.has(label)) continue;

        let best: { canonical: string; distance: number } | null = null;
        for (const canonical of NORMALISED_CANONICAL) {
            if (Math.abs(canonical.length - label.length) > 3) continue;
            const distance = levenshtein(label, canonical);
            if (!best || distance < best.distance) best = { canonical, distance };
        }

        if (best && best.distance > 0 && best.distance <= 2) {
            warnings.push({ submitted: raw, closestCanonical: best.canonical, distance: best.distance });
        }
    }

    return warnings;
}
