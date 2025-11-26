/**
 * Debug endpoint to remove strategy whitelist
 * 
 * POST /debug/remove-strategy-whitelist
 * 
 * Removes the PROPOSAL_STRATEGY_WHITELIST setting to allow all strategies.
 * Only available in SANDBOX_PAPER mode.
 */

import type { Env } from '../env';
import { deleteSetting } from '../db/queries';
import { getTradingMode } from '../core/config';

export async function handleDebugRemoveStrategyWhitelist(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const tradingMode = await getTradingMode(env);
    if (tradingMode !== 'SANDBOX_PAPER') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'This endpoint is only available in SANDBOX_PAPER mode.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    await deleteSetting(env, 'PROPOSAL_STRATEGY_WHITELIST');

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Strategy whitelist removed. All enabled strategies will now be considered.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

