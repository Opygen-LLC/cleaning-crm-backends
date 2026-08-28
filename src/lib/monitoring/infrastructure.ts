import {
  APP_REGION,
  DATABASE_REGION,
  DEPLOYMENT_PROFILE,
  PRIMARY_REGION,
  PROCESS_REGION,
  PROCESS_ROLE,
  REDIS_REGION,
  REQUIRE_COLOCATED_INFRA,
} from "../../config/ENV";

const normalize = (value: string | undefined): string | null => {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
};

/**
 * Phase 3 placement model.
 *
 * This intentionally models one primary transactional region while keeping the
 * product globally reachable through the frontend/CDN edge. `PRIMARY_REGION`
 * is an operational label, not a customer-market restriction.
 */
export const getInfrastructureAlignment = () => {
  const appRegion = normalize(APP_REGION);
  const databaseRegion = normalize(DATABASE_REGION);
  const primaryRegion = normalize(PRIMARY_REGION) ?? appRegion;
  const configuredRedisRegion = normalize(REDIS_REGION);
  const redisRegion = configuredRedisRegion === "local" ? appRegion : configuredRedisRegion;
  const processRegion = normalize(PROCESS_REGION) ?? appRegion;

  const known = Boolean(primaryRegion && appRegion && databaseRegion && redisRegion && processRegion);
  const coreAligned = Boolean(
    known &&
    primaryRegion === appRegion &&
    primaryRegion === databaseRegion &&
    primaryRegion === redisRegion,
  );
  const processAligned = Boolean(known && processRegion === primaryRegion);
  const aligned = coreAligned && processAligned;

  return {
    deploymentProfile: DEPLOYMENT_PROFILE,
    processRole: PROCESS_ROLE,
    primaryRegion,
    processRegion,
    appRegion,
    databaseRegion,
    redisRegion,
    known,
    coreAligned,
    processAligned,
    aligned,
    enforcementEnabled: REQUIRE_COLOCATED_INFRA,
    topology: "global-edge-primary-region" as const,
  };
};

export const assertInfrastructureAlignment = (): void => {
  if (!REQUIRE_COLOCATED_INFRA) return;
  const alignment = getInfrastructureAlignment();
  if (!normalize(PRIMARY_REGION)) {
    throw new Error(
      "Infrastructure region enforcement is enabled, but PRIMARY_REGION is not configured. Set one explicit primary transactional region before production startup.",
    );
  }
  if (!alignment.known) {
    throw new Error(
      "Infrastructure region enforcement is enabled, but PRIMARY_REGION, APP_REGION, DATABASE_REGION, REDIS_REGION and the current PROCESS_REGION are not fully resolvable.",
    );
  }
  if (!alignment.coreAligned) {
    throw new Error(
      `Primary infrastructure is not colocated (primary=${alignment.primaryRegion}, api=${alignment.appRegion}, database=${alignment.databaseRegion}, redis=${alignment.redisRegion}). Keep API/PostgreSQL/Redis in the primary region before serving production traffic.`,
    );
  }
  if (!alignment.processAligned) {
    throw new Error(
      `The ${alignment.processRole} process is outside the primary region (process=${alignment.processRegion}, primary=${alignment.primaryRegion}). Database-heavy API/worker/scheduler processes must remain near the transactional stack in this deployment stage.`,
    );
  }
};
