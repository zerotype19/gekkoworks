/**
 * SAS v1 Risk State Endpoint
 * 
 * Read-only endpoint to get current risk state.
 * Per architecture.md and system-interfaces.md.
 */

import type { Env } from '../env';
import { getRiskSnapshot } from '../core/risk';

/**
 * Handle risk state request
 * 
 * Per system-interfaces.md:
 * export async function handleRiskState(
 *   request: Request,
 *   env: Env,
 *   ctx: ExecutionContext
 * ): Promise<Response>;
 */
export async function handleRiskState(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const now = new Date();
    const riskSnapshot = await getRiskSnapshot(env, now);
    
    return new Response(
      JSON.stringify(riskSnapshot),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

