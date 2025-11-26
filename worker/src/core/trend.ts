/**
 * Trend Filter Utilities
 * 
 * Implements trend filtering for directional strategies.
 * 
 * Primary conditions:
 * - Bullish strategies (BULL_PUT_CREDIT, BULL_CALL_DEBIT): price > SMA_20
 *   - Soft gate: If price ≤ SMA_20, allow if trendScore >= 0.35 (roughly up to 0.6% below SMA)
 * - Bearish strategies (BEAR_CALL_CREDIT, BEAR_PUT_DEBIT): price < SMA_20
 *   - Soft gate: If price ≥ SMA_20, allow if trendScore >= 0.35 (roughly up to 0.6% above SMA)
 * 
 * Optional: VIX < 23 (not yet implemented)
 * 
 * NOTE: This module exports computeSMA20 which is also used by regime.ts for market regime detection.
 * Consider caching SMA20 per symbol if called multiple times in the same cycle to avoid redundant API calls.
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';

/**
 * Compute SMA_20 from historical prices
 * 
 * Fetches last 20 trading days of closing prices and computes simple moving average.
 * Returns null if data unavailable (will log warning but not block trades in v1).
 */
export async function computeSMA20(
  env: Env,
  symbol: string
): Promise<number | null> {
  try {
    const broker = new TradierClient(env);
    
    // Get historical data (last 30 days to ensure we have 20 trading days)
    // Tradier API: /markets/history?symbol=SPY&interval=daily&start=YYYY-MM-DD&end=YYYY-MM-DD
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30); // Go back 30 days to ensure 20 trading days
    
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    
    // Fetch historical data from Tradier
    const historicalData = await broker.getHistoricalData(symbol, startStr, endStr);
    
    if (historicalData.length < 20) {
      // Not enough data points for SMA_20
      return null;
    }
    
    // Sort by date (most recent first) and take most recent 20 closes
    const sortedData = historicalData
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 20);
    
    // Calculate SMA_20: average of last 20 closing prices
    const sum = sortedData.reduce((acc, day) => acc + day.close, 0);
    const sma20 = sum / sortedData.length;
    
    return sma20;
  } catch (error) {
    console.warn('[trend] Failed to compute SMA_20', JSON.stringify({
      symbol,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

/**
 * Check if bullish trend condition is met
 * 
 * For BULL_PUT_CREDIT and BULL_CALL_DEBIT:
 * - Primary condition: price > SMA_20 (if SMA available)
 * - Soft gate: If price ≤ SMA_20, allow if trendScore >= 0.35 (roughly up to 0.6% below SMA)
 * - Optional: VIX < 23 (if VIX available, not yet implemented)
 * 
 * Returns { valid: boolean; trendScore: number; reason?: string }
 * trendScore: 0-1 scale where 1.0 = strongly bullish, 0.0 = strongly bearish
 * 
 * NOTE: If called multiple times for the same symbol in a cycle, consider caching the SMA20
 * result to avoid redundant API calls.
 */
export async function checkBullishTrend(
  env: Env,
  symbol: string,
  currentPrice: number
): Promise<{ valid: boolean; trendScore: number; reason?: string }> {
  // Compute SMA_20
  const sma20 = await computeSMA20(env, symbol);
  
  let trendScore = 0.5; // Default neutral if SMA unavailable
  
  if (sma20 !== null) {
    const priceVsSMA = (currentPrice - sma20) / sma20;
    
    // Compute trend score: 1.0 if price >> SMA, 0.0 if price << SMA
    // Linear scale: price = SMA → 0.5, price = SMA + 2% → 1.0, price = SMA - 2% → 0.0
    trendScore = Math.max(0, Math.min(1, 0.5 + (priceVsSMA / 0.04)));
    
    if (currentPrice <= sma20) {
      return {
        valid: trendScore >= 0.35, // Softer gating: allow if trendScore >= 0.35
        trendScore,
        reason: `Price (${currentPrice.toFixed(2)}) <= SMA_20 (${sma20.toFixed(2)}), trendScore: ${trendScore.toFixed(3)}`,
      };
    }
  } else {
    // SMA not available - default to neutral (0.5) and allow trade
    console.log('[trend] SMA_20 not available - using neutral trendScore (0.5)', JSON.stringify({
      symbol,
      currentPrice,
    }));
  }
  
  // TODO: Add VIX check if VIX data is available
  // When implementing:
  // - Consider mode-dependent behavior (e.g., ignore VIX in SANDBOX_PAPER, enforce in LIVE)
  // - Log when VIX is the reason a trade is invalid (different from trend-based rejection)
  // const vix = await getVIX(env);
  // if (vix !== null && vix >= 23) {
  //   console.log('[trend] VIX rejection', JSON.stringify({ symbol, vix, currentPrice }));
  //   return { valid: false, trendScore: 0, reason: `VIX (${vix.toFixed(2)}) >= 23` };
  // }
  
  return { valid: true, trendScore };
}

/**
 * Check if bearish trend condition is met
 * 
 * For BEAR_CALL_CREDIT and BEAR_PUT_DEBIT:
 * - Primary condition: price < SMA_20 (if SMA available)
 * - Soft gate: If price ≥ SMA_20, allow if trendScore >= 0.35 (roughly up to 0.6% above SMA)
 * 
 * Returns { valid: boolean; trendScore: number; reason?: string }
 * trendScore: 0-1 scale where 1.0 = strongly bearish, 0.0 = strongly bullish
 * 
 * NOTE: If called multiple times for the same symbol in a cycle, consider caching the SMA20
 * result to avoid redundant API calls.
 */
export async function checkBearishTrend(
  env: Env,
  symbol: string,
  currentPrice: number
): Promise<{ valid: boolean; trendScore: number; reason?: string }> {
  // Compute SMA_20
  const sma20 = await computeSMA20(env, symbol);
  
  let trendScore = 0.5; // Default neutral if SMA unavailable
  
  if (sma20 !== null) {
    const priceVsSMA = (currentPrice - sma20) / sma20;
    
    // Compute trend score: 1.0 if price << SMA (bearish), 0.0 if price >> SMA (bullish)
    // Linear scale: price = SMA → 0.5, price = SMA - 2% → 1.0, price = SMA + 2% → 0.0
    trendScore = Math.max(0, Math.min(1, 0.5 - (priceVsSMA / 0.04)));
    
    if (currentPrice >= sma20) {
      return {
        valid: trendScore >= 0.35, // Softer gating: allow if trendScore >= 0.35
        trendScore,
        reason: `Price (${currentPrice.toFixed(2)}) >= SMA_20 (${sma20.toFixed(2)}), trendScore: ${trendScore.toFixed(3)}`,
      };
    }
  } else {
    // SMA not available - default to neutral (0.5) and allow trade
    console.log('[trend] SMA_20 not available - using neutral trendScore (0.5)', JSON.stringify({
      symbol,
      currentPrice,
    }));
  }
  
  return { valid: true, trendScore };
}

