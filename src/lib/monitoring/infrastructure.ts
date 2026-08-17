import {
  APP_REGION,
  DATABASE_REGION,
  REDIS_REGION,
  REQUIRE_COLOCATED_INFRA,
} from "../../config/ENV";

const normalize = (value: string | undefined): string | null => {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
};

export const getInfrastructureAlignment = () => {
  const appRegion = normalize(APP_REGION);
  const databaseRegion = normalize(DATABASE_REGION);
  const configuredRedisRegion = normalize(REDIS_REGION);
  const redisRegion = configuredRedisRegion === "local" ? appRegion : configuredRedisRegion;
  const known = Boolean(appRegion && databaseRegion && redisRegion);
  const aligned = known && appRegion === databaseRegion && appRegion === redisRegion;

  return {
    appRegion,
    databaseRegion,
    redisRegion,
    known,
    aligned,
    enforcementEnabled: REQUIRE_COLOCATED_INFRA,
  };
};

export const assertInfrastructureAlignment = (): void => {
  if (!REQUIRE_COLOCATED_INFRA) return;
  const alignment = getInfrastructureAlignment();
  if (!alignment.known) {
    throw new Error(
      "Infrastructure region enforcement is enabled, but APP_REGION, DATABASE_REGION and REDIS_REGION are not fully configured.",
    );
  }
  if (!alignment.aligned) {
    throw new Error(
      `Infrastructure regions are not aligned (app=${alignment.appRegion}, database=${alignment.databaseRegion}, redis=${alignment.redisRegion}). Move API/Postgres/Redis into the same region before starting production traffic.`,
    );
  }
};
