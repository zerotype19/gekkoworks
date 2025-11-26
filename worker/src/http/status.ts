/**
 * SAS v1 Status Endpoint
 * 
 * Read-only endpoint to get current system status and risk state.
 * Per architecture.md and system-interfaces.md.
 */

import type { Env } from '../env';
import { getRiskSnapshot } from '../core/risk';
import { getOpenTrades } from '../db/queries';
import { isMarketHours, isTradingDay } from '../core/time';
import { getTradingMode } from '../core/config';

/**
 * Handle status request
 * 
 * Per system-interfaces.md:
 * export async function handleStatus(
 *   request: Request,
 *   env: Env,
 *   ctx: ExecutionContext
 * ): Promise<Response>;
 */
export async function handleStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const now = new Date();
    const riskSnapshot = await getRiskSnapshot(env, now);
    const openTrades = await getOpenTrades(env);
    const tradingMode = await getTradingMode(env);
    
    // All trades are managed by Gekkoworks
    return new Response(
      JSON.stringify({
        system_mode: riskSnapshot.system_mode,
        risk_state: riskSnapshot.risk_state,
        daily_realized_pnl: riskSnapshot.daily_realized_pnl,
        emergency_exit_count_today: riskSnapshot.emergency_exit_count_today,
        open_positions: openTrades.length,
        trading_mode: tradingMode,
        market_hours: isMarketHours(now),
        trading_day: isTradingDay(now),
        timestamp: now.toISOString(),
      }),
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

