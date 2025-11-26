/**
 * SAS v1 Health Endpoint
 * 
 * Read-only endpoint to check if worker is alive.
 * Per architecture.md and system-interfaces.md.
 */

import type { Env } from '../env';

/**
 * Handle health check
 * 
 * Per system-interfaces.md:
 * export async function handleHealth(
 *   request: Request,
 *   env: Env,
 *   ctx: ExecutionContext
 * ): Promise<Response>;
 */
export async function handleHealth(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'gekkoworks-api',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
}

