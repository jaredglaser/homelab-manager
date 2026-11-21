export const LANE_SESSION_TTL_HOURS = 3;
export const LANE_SESSION_TTL_SECONDS = LANE_SESSION_TTL_HOURS * 3600;
export const LANE_DATABASE = 'homelab_test';

export interface LaneDatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** The lane inserts users and sessions, so it must never resolve to a development database through a .env default. */
export function assertLaneDatabase(): string {
  const database = process.env.POSTGRES_DB;
  if (database !== LANE_DATABASE) {
    throw new Error(
      `The auth e2e lane writes users and sessions, so POSTGRES_DB must be exactly ${LANE_DATABASE} ` +
        `(got ${database ?? 'unset'}). Point POSTGRES_* at a throwaway Postgres.`,
    );
  }
  return database;
}

export function laneDatabaseConfig(): LaneDatabaseConfig {
  const database = assertLaneDatabase();
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? '5432'),
    database,
    user: process.env.POSTGRES_USER ?? 'homelab',
    password: process.env.POSTGRES_PASSWORD ?? '',
  };
}
