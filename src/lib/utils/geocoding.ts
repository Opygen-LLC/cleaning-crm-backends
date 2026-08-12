/**
 * geocoding.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around Google Maps Geocoding API / Mapbox Geocoding API.
 *
 * Design goals:
 *   - NEVER throw out of `geocodeAddressSafely` — a bad/ambiguous address or
 *     a provider outage must not block a client/job/staff create-or-update.
 *     Callers get `null` back and simply store no coordinates; the record
 *     stays fully usable, it just won't participate in proximity scoring.
 *   - Provider is explicit (GEOCODING_PROVIDER=google|mapbox) rather than
 *     inferred, so a misconfigured env fails loudly in logs instead of
 *     silently doing nothing.
 *   - No SDK dependency — both providers are simple REST calls, and Node 22
 *     ships a global `fetch`, so we avoid adding axios/node-fetch just for
 *     this.
 */

import {
    GEOCODING_PROVIDER,
    GOOGLE_MAPS_API_KEY,
    MAPBOX_ACCESS_TOKEN,
} from "../../config/ENV";
import logger from "../logger";

export interface GeocodeResult {
    latitude: number;
    longitude: number;
    /** Provider's normalized/formatted address, useful for debugging mismatches. */
    formattedAddress?: string;
}

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const MAPBOX_GEOCODE_URL =
    "https://api.mapbox.com/geocoding/v5/mapbox.places";

// PERF FIX (Phase 5.1): neither provider call had a timeout, so a slow or
// hanging geocoding provider could stall a job/client create-or-update
// request indefinitely — the request would just sit there until the
// provider eventually responded (or the client gave up). Geocoding is
// explicitly "best effort" per the design goals above, so it must never be
// allowed to block longer than this. 4s is generous for a geocoding API
// under normal conditions but short enough that a slow provider degrades
// gracefully instead of stalling the request.
const GEOCODE_TIMEOUT_MS = 4_000;

const isConfigured = (): boolean => {
    if (GEOCODING_PROVIDER === "google") return Boolean(GOOGLE_MAPS_API_KEY);
    if (GEOCODING_PROVIDER === "mapbox") return Boolean(MAPBOX_ACCESS_TOKEN);
    return false;
};

const geocodeWithGoogle = async (
    address: string,
): Promise<GeocodeResult | null> => {
    const url = `${GOOGLE_GEOCODE_URL}?address=${encodeURIComponent(
        address,
    )}&key=${GOOGLE_MAPS_API_KEY}`;

    // PERF FIX (Phase 5.1): bounded with AbortSignal.timeout so a slow/hung
    // provider can never block the caller past GEOCODE_TIMEOUT_MS.
    const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`Google geocoding HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
        status: string;
        results: {
            geometry: { location: { lat: number; lng: number } };
            formatted_address: string;
        }[];
    };

    if (body.status !== "OK" || body.results.length === 0) {
        // ZERO_RESULTS / OVER_QUERY_LIMIT / REQUEST_DENIED etc. — all
        // treated as "couldn't geocode this one", not a hard failure.
        return null;
    }

    const [first] = body.results;
    return {
        latitude: first.geometry.location.lat,
        longitude: first.geometry.location.lng,
        formattedAddress: first.formatted_address,
    };
};

const geocodeWithMapbox = async (
    address: string,
): Promise<GeocodeResult | null> => {
    const url = `${MAPBOX_GEOCODE_URL}/${encodeURIComponent(
        address,
    )}.json?access_token=${MAPBOX_ACCESS_TOKEN}&limit=1`;

    // PERF FIX (Phase 5.1): bounded with AbortSignal.timeout so a slow/hung
    // provider can never block the caller past GEOCODE_TIMEOUT_MS.
    const res = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`Mapbox geocoding HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
        features: {
            center: [number, number]; // [lng, lat]
            place_name: string;
        }[];
    };

    if (!body.features || body.features.length === 0) return null;

    const [first] = body.features;
    return {
        latitude: first.center[1],
        longitude: first.center[0],
        formattedAddress: first.place_name,
    };
};

/**
 * Geocode a free-text address into lat/lng. Returns `null` (never throws)
 * if geocoding isn't configured, the address can't be resolved, or the
 * provider errors out — callers should treat that as "no coordinates yet"
 * rather than a request failure.
 */
export const geocodeAddressSafely = async (
    address: string,
): Promise<GeocodeResult | null> => {
    const trimmed = address?.trim();
    if (!trimmed) return null;

    if (!isConfigured()) {
        // Not an error — most local/dev environments won't have a geocoding
        // key set. Dispatch just runs without proximity scoring.
        return null;
    }

    try {
        if (GEOCODING_PROVIDER === "google") {
            return await geocodeWithGoogle(trimmed);
        }
        if (GEOCODING_PROVIDER === "mapbox") {
            return await geocodeWithMapbox(trimmed);
        }
        return null;
    } catch (err) {
        logger.warn(
            `[GEOCODING] Failed to geocode "${trimmed}" via ${GEOCODING_PROVIDER}`,
            err,
        );
        return null;
    }
};

/** Builds a single geocodable line from Client-style structured address fields. */
export const buildAddressString = (parts: {
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    zipcode?: string | null;
    country?: string | null;
}): string =>
    [
        parts.addressLine1,
        parts.addressLine2,
        parts.city,
        parts.zipcode,
        parts.country,
    ]
        .filter((p) => p && p.trim().length > 0)
        .join(", ");
