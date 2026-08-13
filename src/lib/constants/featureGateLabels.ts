// ─── Canonical feature-gate labels ────────────────────────────────────────────
//
// This is the backend's copy of the canonical feature strings defined in the
// frontend's `src/lib/featureGateConfig.ts` (GATE_DEFINITIONS). The two repos
// are deployed independently, so we can't literally share one TS module —
// this list must be kept in sync by hand whenever a gate is added/renamed
// there. If you change featureGateConfig.ts, mirror the change here too.
//
// WHY THIS EXISTS
// ────────────────
// SubscriptionPlan.features is canonical JSON ({ label, included, limit? }).
// The super-admin plan editor renders a checkbox for every canonical gate
// (so a typo there is no longer possible) plus a free-text field for
// custom/marketing-only labels (e.g. "Priority support") that don't gate any
// specific page. That free-text field, and any direct API call bypassing the
// UI, can still introduce a near-miss typo of a canonical string (e.g.
// "recuring bookings") that silently fails to unlock the page it was meant
// to, with no error anywhere. This module catches that class of mistake at
// the API boundary without rejecting legitimate custom labels.

export const CANONICAL_FEATURE_LABELS: string[] = [
    // Bookings
    "recurring bookings",
    "recurring schedules",
    // Online Booking
    "online booking",
    "online booking portal",
    "online booking builder",
    "booking page builder",
    "booking availability",
    "availability & time slots",
    "online booking settings",
    "booking submissions",
    "online booking submissions",
    // Estimates / Pricing Forms
    "pricing forms",
    "estimate forms",
    "pricing form builder",
    "estimate form builder",
    "estimate submissions",
    // Finance
    "coupons",
    "coupon management",
    // Jobs
    "auto-dispatch",
    "dispatch board",
    "auto dispatch",
    // Leads
    "leads pipeline",
    "pipeline view",
    // Reports
    "reports",
    "analytics",
    "revenue reports",
    "revenue report",
    "client retention reports",
    "client retention report",
    "job completion reports",
    "job completion report",
    "staff performance reports",
    "staff performance report",
    // Reviews
    "reviews",
    "client reviews",
    "staff reviews",
    // Settings
    "advanced pricing rules",
    "pricing rules",
    // Team
    "leave approvals",
    "staff leave",
    "team performance",
    "staff performance",
];

function normalise(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const NORMALISED_CANONICAL = new Set(
    CANONICAL_FEATURE_LABELS.map((f) => normalise(f)),
);

/** Classic Levenshtein edit distance — small strings only, no need to optimise. */
function levenshtein(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
        Array(b.length + 1).fill(i === 0 ? 0 : 0),
    );
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] =
                    1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
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
 * Flags submitted feature labels that are suspiciously close (but not
 * identical) to a canonical gate label — the classic typo case
 * ("recuring bookings" instead of "recurring bookings"), which would
 * otherwise silently fail to unlock the intended page for every admin on
 * that plan.
 *
 * Deliberately does NOT reject exact non-canonical strings outright —
 * plans are allowed to carry freeform marketing bullet points (e.g.
 * "Priority support") that don't correspond to any gate. Only near-misses
 * (edit distance 1–2 from a canonical label, on a string of comparable
 * length) are flagged.
 */
export function findNearMissFeatureLabels(
    labels: string[],
): FeatureLabelWarning[] {
    const warnings: FeatureLabelWarning[] = [];

    for (const raw of labels) {
        const label = normalise(raw);
        if (!label) continue;
        if (NORMALISED_CANONICAL.has(label)) continue; // exact match — fine

        let best: { canonical: string; distance: number } | null = null;
        for (const canonical of NORMALISED_CANONICAL) {
            // Skip comparisons where length differs too much to plausibly be
            // a typo of each other — keeps this cheap and avoids nonsense
            // matches between unrelated short/long strings.
            if (Math.abs(canonical.length - label.length) > 3) continue;

            const distance = levenshtein(label, canonical);
            if (!best || distance < best.distance) {
                best = { canonical, distance };
            }
        }

        // Distance 1-2 on a reasonably short label is almost always a typo,
        // not a coincidentally similar but intentionally different phrase.
        if (best && best.distance > 0 && best.distance <= 2) {
            warnings.push({
                submitted: raw,
                closestCanonical: best.canonical,
                distance: best.distance,
            });
        }
    }

    return warnings;
}
