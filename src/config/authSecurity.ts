import {
    ACCESS_TOKEN_EXPIRES_IN,
    APP_URL,
    AUTH_ALLOWED_ORIGINS,
    BETTER_AUTH_URL,
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

export const assertAuthSecurityConfiguration = (): void => {
    if (NODE_ENV !== "production") return;

    const frontend = normalizeOrigin(FRONTEND_URL);
    const app = normalizeOrigin(APP_URL);
    const api = normalizeOrigin(BETTER_AUTH_URL);
    if (!frontend || !app || !api) {
        throw new Error("FRONTEND_URL, APP_URL and BETTER_AUTH_URL must be absolute production URLs");
    }

    const frontendUrl = new URL(frontend);
    const apiUrl = new URL(api);
    const isIpHost = /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/i.test(api) || /^https?:\/\/localhost(:\d+)?/i.test(api);

    if ((frontendUrl.protocol !== "https:" || apiUrl.protocol !== "https:") && !isIpHost && process.env.ALLOW_HTTP_API_PROXY !== "true") {
        throw new Error("Production frontend/API authentication origins must use HTTPS");
    }

    const accessMs = parseDurationMs(ACCESS_TOKEN_EXPIRES_IN);
    if (!accessMs || accessMs <= 0) {
        throw new Error("ACCESS_TOKEN_EXPIRES_IN must be a valid duration");
    }

    const explicitAllowedOrigins = AUTH_ALLOWED_ORIGINS
        .map(normalizeOrigin)
        .filter((value): value is string => Boolean(value));

    if (!explicitAllowedOrigins.includes(frontend) && !isIpHost) {
        throw new Error("AUTH_ALLOWED_ORIGINS must explicitly include FRONTEND_URL");
    }
};

export const assertProcessRole = (expected: ProcessRole): void => {
    if (PROCESS_ROLE !== expected) {
        throw new Error(`This entrypoint requires PROCESS_ROLE=${expected}; received ${PROCESS_ROLE}`);
    }
};
