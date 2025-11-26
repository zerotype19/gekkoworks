/**
 * Debug endpoint: /debug/live-signals
 * 
 * Returns live market signals including:
 * - Price, SMA_5, SMA_20, SMA_50
 * - VIX, ATR_10
 * - Momentum state, volatility state
 * - Current regime and allowed strategies
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { detectRegime, getStrategiesForRegime } from '../core/regime';
import { computeSMA20 } from '../core/trend';

export async function handleDebugLiveSignals(env: Env): Promise<Response> {
  try {
    const broker = new TradierClient(env);
    const symbol = 'SPY';
    
    // Get current price
    const underlying = await broker.getUnderlyingQuote(symbol);
    const currentPrice = underlying.last;
    
    // Compute SMAs (placeholder until historical data is fully implemented)
    const sma20 = await computeSMA20(env, symbol);
    const sma5 = await computeSMA5(env, symbol); // Placeholder
    const sma50 = await computeSMA50(env, symbol); // Placeholder
    
    // Compute ATR_10 (placeholder)
    const atr10 = await computeATR10(env, symbol);
    
    // Get VIX (placeholder - would need VIX data source)
    const vix = await getVIX(env);
    
    // Determine momentum state
    let momentumState: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    if (sma5 !== null && sma20 !== null) {
      if (currentPrice > sma5 && sma5 > sma20) {
        momentumState = 'UP';
      } else if (currentPrice < sma5 && sma5 < sma20) {
        momentumState = 'DOWN';
      }
    }
    
    // Determine volatility state
    let volatilityState: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM';
    if (vix !== null) {
      if (vix < 15) {
        volatilityState = 'LOW';
      } else if (vix > 25) {
        volatilityState = 'HIGH';
      }
    }
    
    // Detect regime
    const regimeState = await detectRegime(env, symbol, currentPrice);
    const { enabled: strategiesAllowed } = getStrategiesForRegime(regimeState.regime);
    
    const response = {
      symbol,
      price: currentPrice,
      SMA_5: sma5,
      SMA_20: sma20,
      SMA_50: sma50,
      VIX: vix,
      ATR_10: atr10,
      momentum_state: momentumState,
      volatility_state: volatilityState,
      regime: regimeState.regime,
      strategies_allowed: strategiesAllowed,
      timestamp: new Date().toISOString(),
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[debug][live-signals][error]', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Compute SMA_5 (placeholder - needs historical data)
 */
async function computeSMA5(env: Env, symbol: string): Promise<number | null> {
  // TODO: Implement historical data fetching
  return null;
}

/**
 * Compute SMA_50 (placeholder - needs historical data)
 */
async function computeSMA50(env: Env, symbol: string): Promise<number | null> {
  // TODO: Implement historical data fetching
  return null;
}

/**
 * Compute ATR_10 (Average True Range over 10 days)
 */
async function computeATR10(env: Env, symbol: string): Promise<number | null> {
  // TODO: Implement ATR calculation from historical data
  return null;
}

/**
 * Get VIX value
 */
async function getVIX(env: Env): Promise<number | null> {
  // TODO: Implement VIX data fetching
  // Could use Tradier API or another data source
  return null;
}

