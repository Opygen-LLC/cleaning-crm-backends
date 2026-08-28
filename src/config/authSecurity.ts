import {
    ACCESS_TOKEN_EXPIRES_IN,
    APP_URL,
    AUTH_ALLOWED_ORIGINS,
    BETTER_AUTH_URL,
    COOKIE_DOMAIN,
    FRONTEND_URL,
    NODE_ENV,
    PROCESS_ROLE,
    type ProcessRole,
} from "./ENV";

const normalizeOrigin = (value: string | undefined): string | null => {
    if (!value?.trim()) return null;
    try {
        const url = new URL(value.trim());
        return url.origin;
    } catch {
        return null;
    }
};

export const getAuthenticatedOrigins = (): string[] => {
    const values = [FRONTEND_URL, APP_URL, BETTER_AUTH_URL, ...AUTH_ALLOWED_ORIGINS]
        .map(normalizeOrigin)
        .filter((value): value is string => Boolean(value));

    if (NODE_ENV !== "production") {
        values.push("http://localhost:3000", "http://localhost:3001", "http://localhost:5000");
    }

    return [...new Set(values)];
};

const parseDurationMs = (value: string): number | null => {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return amount * multiplier;
};

const hostBelongsToCookieDomain = (host: string, cookieDomain: string): boolean => {
    const parent = cookieDomain.replace(/^\./, "").toLowerCase();
    const normalized = host.toLowerCase();
    return normalized === parent || normalized.endsWith(`.${parent}`);
};

export const assertAuthSecurityConfiguration = (): void => {
    if (NODE_ENV !== "production") return;

    const frontend = normalizeOrigin(FRONTEND_URL);
    const api = normalizeOrigin(BETTER_AUTH_URL);
    if (!frontend || !api) throw new Error("FRONTEND_URL and BETTER_AUTH_URL must be absolute production URLs");

    const frontendUrl = new URL(frontend);
    const apiUrl = new URL(api);
    if (frontendUrl.protocol !== "https:" || apiUrl.protocol !== "https:") {
        throw new Error("Production frontend/API authentication origins must use HTTPS");
    }

    if (!COOKIE_DOMAIN || !COOKIE_DOMAIN.startsWith(".") || !COOKIE_DOMAIN.includes(".")) {
        throw new Error("COOKIE_DOMAIN is required in production and must be a shared parent domain such as .opygen.com");
    }

    if (!hostBelongsToCookieDomain(frontendUrl.hostname, COOKIE_DOMAIN) || !hostBelongsToCookieDomain(apiUrl.hostname, COOKIE_DOMAIN)) {
        throw new Error("FRONTEND_URL and BETTER_AUTH_URL must both belong to COOKIE_DOMAIN");
    }

    const accessMs = parseDurationMs(ACCESS_TOKEN_EXPIRES_IN);
    if (!accessMs || accessMs < 5 * 60_000 || accessMs > 30 * 60_000) {
        throw new Error("ACCESS_TOKEN_EXPIRES_IN must be between 5m and 30m in production (recommended: 15m)");
    }

    if (!getAuthenticatedOrigins().includes(frontend)) {
        throw new Error("FRONTEND_URL must be included in authenticated origin policy");
    }
};

export const assertProcessRole = (expected: ProcessRole): void => {
    if (PROCESS_ROLE !== expected) {
        throw new Error(`This entrypoint requires PROCESS_ROLE=${expected}; received ${PROCESS_ROLE}`);
    }
};
