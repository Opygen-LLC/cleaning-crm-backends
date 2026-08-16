import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import AppError from "../../errorHelper/AppError";
import status from "http-status";
import { RESERVED_WEBSITE_SUBDOMAINS } from "./website.constant";

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const normalizeSubdomain = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 63 || !DOMAIN_LABEL.test(normalized)) {
    throw new AppError(status.BAD_REQUEST, "Subdomain must be 3-63 lowercase letters, numbers, or hyphens and cannot start/end with a hyphen");
  }
  if (RESERVED_WEBSITE_SUBDOMAINS.has(normalized)) {
    throw new AppError(status.CONFLICT, "That subdomain is reserved by the platform");
  }
  return normalized;
};

export const normalizeDomain = (value: string): string => {
  const raw = value.trim().replace(/\.$/, "");
  if (!raw || raw.includes("://") || raw.includes("/") || raw.includes("@") || raw.includes(":")) {
    throw new AppError(status.BAD_REQUEST, "Enter a hostname only, without protocol, path, credentials, or port");
  }
  const ascii = domainToASCII(raw).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii === "localhost" || isIP(ascii)) {
    throw new AppError(status.BAD_REQUEST, "Enter a valid public domain name");
  }
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new AppError(status.BAD_REQUEST, "Enter a valid public domain name");
  }
  return ascii;
};

export const normalizePageSlug = (value: string): string => {
  const raw = value.trim();
  if (raw === "/") return "/";
  const path = `/${raw.replace(/^\/+|\/+$/g, "")}`.toLowerCase();
  if (!/^\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/.test(path)) {
    throw new AppError(status.BAD_REQUEST, "Page path may contain lowercase letters, numbers, hyphens, and path separators only");
  }
  return path;
};

export const assertSafeHttpsUrl = (value: string | null | undefined, fieldName: string): string | null | undefined => {
  if (value == null || value === "") return value == null ? value : null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(status.BAD_REQUEST, `${fieldName} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new AppError(status.BAD_REQUEST, `${fieldName} must use HTTPS and cannot contain credentials`);
  }
  return parsed.toString();
};
