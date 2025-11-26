/**
 * Auto Mode Configuration Debug Endpoint
 * 
 * Returns current auto mode settings and score thresholds.
 */

import type { Env } from '../env';
import { getTradingMode, getMinScore, getStrategyThresholds, type TradingMode } from '../core/config';
import { getSetting } from '../db/queries';

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

export async function handleDebugAutoConfig(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    const envMode = await getTradingMode(env);
    const autoModeEnabledPaper = (await getSetting(env, 'AUTO_MODE_ENABLED_PAPER')) === 'true';
    const autoModeEnabledLive = (await getSetting(env, 'AUTO_MODE_ENABLED_LIVE')) === 'true';
    const minScorePaper = await getMinScore(env);
    const minScoreLive = parseFloat(
      (await getSetting(env, 'MIN_SCORE_LIVE')) || '95'
    );
    const strategyThresholds = await getStrategyThresholds(env);
    
    // Determine if auto mode is enabled for current mode
    let isAutoModeEnabled = false;
    if (envMode === 'SANDBOX_PAPER') {
      isAutoModeEnabled = autoModeEnabledPaper;
    } else if (envMode === 'LIVE') {
      isAutoModeEnabled = autoModeEnabledLive;
    }
    
    return new Response(
      JSON.stringify({
        timestamp: now.toISOString(),
        envMode,
        autoMode: {
          enabled: isAutoModeEnabled,
          paper: autoModeEnabledPaper,
          live: autoModeEnabledLive,
        },
        scoreThresholds: {
          paper: minScorePaper,
          live: minScoreLive,
          current: envMode === 'SANDBOX_PAPER' ? minScorePaper : envMode === 'LIVE' ? minScoreLive : 70,
        },
        strategyConfig: {
          dte_min: strategyThresholds.minDte,
          dte_max: strategyThresholds.maxDte,
          delta_min: strategyThresholds.minDelta,
          delta_max: strategyThresholds.maxDelta,
          min_credit_fraction: strategyThresholds.minCreditFraction,
          symbols_paper: getEligibleSymbols('SANDBOX_PAPER'),
          symbols_live: getEligibleSymbols('LIVE'),
        },
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

