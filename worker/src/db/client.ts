/**
 * SAS v1 Database Client
 * 
 * Thin wrapper around D1Database.
 * All DB access must go through this module and queries.ts
 * to avoid direct SQL scattered in business logic.
 */

import type { Env } from '../env';

/**
 * Get the D1 database instance from environment
 */
export function getDB(env: Env): D1Database {
  return env.DB;
}

