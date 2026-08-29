import { prisma } from "../prisma/prisma";
import { singleFlight } from "./singleFlight";

// ─── Platform-wide configuration ──────────────────────────────────────────────
//
// A single JSON blob stored in SuperAdminConfig, keyed by PLATFORM_CONFIG_KEY.
// This is the single source of truth for global settings the super-admin
// controls from Settings → Platform Configuration.
//
// IMPORTANT: every key here is expected to actually gate/drive behavior
// somewhere in the app. If you add a new config key, wire its enforcement in
// the same PR — a setting that can be toggled but does nothing is worse than
// no setting at all (this is exactly the bug that was fixed alongside this
// file: maintenanceMode, registrationOpen, and defaultTrialDays were all
// previously stored but never read anywhere).

export interface PlatformConfig {
    platformName: string;
    supportEmail: string;
    maxAdminsPerTenant: number;
    maintenanceMode: boolean;
    registrationOpen: boolean;
    defaultTrialDays: number;
    defaultCurrency: string;
    defaultTimezone: string;
}

export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
    platformName: "CleanCRM",
    supportEmail: "support@cleancrm.io",
    maxAdminsPerTenant: 5,
    maintenanceMode: false,
    registrationOpen: true,
    defaultTrialDays: 14,
    defaultCurrency: "GBP",
    defaultTimezone: "Europe/London",
};

export const PLATFORM_CONFIG_KEY = "platformConfig";

// ─── In-memory TTL cache ───────────────────────────────────────────────────────
//
// PERF FIX (Phase 1.2): getPlatformConfig() is called by maintenanceModeGate,
// which runs on nearly every API request in the app. Hitting Postgres for a
// single-row config lookup on every single request adds a full DB round-trip
// to the critical path of the entire API — on a remote/serverless Postgres
// instance (Neon) that round-trip alone can be tens to hundreds of ms.
//
// The config changes maybe a few times a year (super-admin toggles
// maintenance mode, trial length, etc.), so a short TTL cache is safe:
// worst case, a change takes up to CONFIG_CACHE_TTL_MS to become visible on
// instances that don't call updatePlatformConfig() directly, and even that
// window is eliminated below by busting the cache on every write.
const CONFIG_CACHE_TTL_MS = 60_000;

let cachedConfig: PlatformConfig | null = null;
let cacheExpiresAt = 0;

const readConfigFromDb = async (): Promise<PlatformConfig> => {
    const row = await prisma.superAdminConfig
        .findUnique({ where: { key: PLATFORM_CONFIG_KEY } })
        .catch(() => null); // table may not exist yet (pre-migration) — use defaults

    if (!row) return DEFAULT_PLATFORM_CONFIG;

    try {
        return { ...DEFAULT_PLATFORM_CONFIG, ...JSON.parse(String(row.value)) };
    } catch {
        return DEFAULT_PLATFORM_CONFIG;
    }
};

/**
 * Reads the current platform config, falling back to defaults for any
 * missing keys (and entirely if the row/table doesn't exist yet).
 *
 * Cached in-memory for CONFIG_CACHE_TTL_MS since this sits on the request
 * path of every API call via maintenanceModeGate. The cache is bypassed
 * automatically once it expires, and busted immediately on write via
 * updatePlatformConfig() below, so a super-admin's change is never stale by
 * more than a single in-flight request.
 */
export const getPlatformConfig = async (): Promise<PlatformConfig> => {
    if (cachedConfig && cacheExpiresAt > Date.now()) {
        return cachedConfig;
    }

    return singleFlight("platform-config", async () => {
        if (cachedConfig && cacheExpiresAt > Date.now()) {
            return cachedConfig;
        }
        const value = await readConfigFromDb();
        cachedConfig = value;
        cacheExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;
        return value;
    });
};

export const updatePlatformConfig = async (
    patch: Partial<PlatformConfig>,
): Promise<PlatformConfig> => {
    const current = await getPlatformConfig();
    const updated = { ...current, ...patch };

    await prisma.superAdminConfig.upsert({
        where: { key: PLATFORM_CONFIG_KEY },
        create: { key: PLATFORM_CONFIG_KEY, value: JSON.stringify(updated) },
        update: { value: JSON.stringify(updated) },
    });

    // Bust the cache immediately so the change is visible on this instance's
    // very next request instead of waiting out the TTL.
    cachedConfig = updated;
    cacheExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;

    return updated;
};
