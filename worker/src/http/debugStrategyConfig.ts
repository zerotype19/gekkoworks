/**
 * Strategy Configuration Debug Endpoint
 * 
 * Returns current strategy thresholds (DTE, delta, credit, symbols).
 */

import type { Env } from '../env';
import { getTradingMode, getStrategyThresholds, type TradingMode } from '../core/config';

/**
 * Get eligible symbols for proposal generation based on trading mode
 */
function getEligibleSymbols(mode: TradingMode): string[] {
  if (mode === 'SANDBOX_PAPER') {
    return ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'];
  }
  if (mode === 'LIVE') {
    return ['SPY']; // Only SPY for LIVE mode
  }
  // DRY_RUN uses PAPER symbols
  return ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'];
}

export async function handleDebugStrategyConfig(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    const envMode = await getTradingMode(env);
    const strategyThresholds = await getStrategyThresholds(env);
    
    return new Response(
      JSON.stringify({
        timestamp: now.toISOString(),
        envMode,
        min_score: strategyThresholds.minScore,
        dte_min: strategyThresholds.minDte,
        dte_max: strategyThresholds.maxDte,
        delta_min: strategyThresholds.minDelta,
        delta_max: strategyThresholds.maxDelta,
        min_credit_fraction: strategyThresholds.minCreditFraction,
        min_credit_for_width_5: 5 * strategyThresholds.minCreditFraction,
        symbols_paper: getEligibleSymbols('SANDBOX_PAPER'),
        symbols_live: getEligibleSymbols('LIVE'),
        symbols_current: getEligibleSymbols(envMode),
      }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: now.toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

