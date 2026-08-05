/**
 * geo.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Pure geometry helpers for proximity-aware dispatch. No external calls —
 * straight-line (haversine) distance is intentionally used instead of a
 * routing API (Google Distance Matrix / Directions) for the *scoring* pass,
 * because dispatch scores every staff member against every job candidate
 * (O(staff × jobs)) and a routing API call per pair would be slow and
 * expensive at that fan-out. A fixed average-speed heuristic converts the
 * straight-line distance into an estimated drive time, which is enough
 * resolution to rank candidates. If exact ETAs are needed later (e.g. to
 * show on a single confirmed assignment), swap in a routing API call there
 * — that's a 1:1 call, not O(n²).
 */

const EARTH_RADIUS_KM = 6371;

export interface LatLng {
    latitude: number;
    longitude: number;
}

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in kilometers. */
export const haversineDistanceKm = (a: LatLng, b: LatLng): number => {
    const dLat = toRadians(b.latitude - a.latitude);
    const dLon = toRadians(b.longitude - a.longitude);
    const lat1 = toRadians(a.latitude);
    const lat2 = toRadians(b.latitude);

    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

    return EARTH_RADIUS_KM * c;
};

/**
 * Average urban/suburban driving speed used to convert straight-line
 * distance into an estimated travel time. Deliberately conservative (real
 * road distance is usually ~20-40% longer than straight-line, and average
 * speed accounts for traffic/stops) — tune via env if a market needs it.
 */
const ASSUMED_AVG_SPEED_KMH = 35;

/** Rough drive-time estimate in minutes from straight-line distance. */
export const estimateTravelMins = (distanceKm: number): number => {
    const mins = (distanceKm / ASSUMED_AVG_SPEED_KMH) * 60;
    // Floor of 5 minutes for any nonzero distance — avoids implying
    // "instant" travel for very close addresses, which reads as a bug.
    return distanceKm <= 0 ? 0 : Math.max(5, Math.round(mins));
};

export const isValidLatLng = (
    lat: number | null | undefined,
    lng: number | null | undefined,
): lat is number => typeof lat === "number" && typeof lng === "number";
