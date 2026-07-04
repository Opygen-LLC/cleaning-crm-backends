import { prisma } from "../prisma/prisma";

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

/**
 * Reads the current platform config, falling back to defaults for any
 * missing keys (and entirely if the row/table doesn't exist yet).
 *
 * Cheap enough to call per-request (single indexed PK lookup); if this ends
 * up on a very hot path, wrap it with a short in-memory TTL cache.
 */
export const getPlatformConfig = async (): Promise<PlatformConfig> => {
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

    return updated;
};
