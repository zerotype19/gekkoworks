/**
 * Market Regime Detection and Strategy Gating
 * 
 * Determines market regime (BULL vs BEAR) based on price vs SMA_20
 * and gates strategy selection accordingly.
 */

import type { Env } from '../env';
import { getSetting, setSetting } from '../db/queries';
import { StrategyId } from '../strategy/types';
import { computeSMA20 } from './trend';

export type MarketRegime = 'BULL' | 'BEAR' | 'NEUTRAL';

export interface RegimeState {
  regime: MarketRegime;
  price: number;
  sma20: number | null;
  timestamp: string;
  previousRegime?: MarketRegime;
  flipped: boolean;
}

/**
 * Detect current market regime based on price vs SMA_20
 * 
 * BULL: price > SMA_20
 * BEAR: price < SMA_20
 * NEUTRAL: price ≈ SMA_20 (within 0.5%) or SMA unavailable
 */
export async function detectRegime(
  env: Env,
  symbol: string,
  currentPrice: number
): Promise<RegimeState> {
  // Get previous regime from settings
  const previousRegimeKey = `REGIME_${symbol}`;
  const previousRegime = (await getSetting(env, previousRegimeKey)) as MarketRegime | null;
  
  // Compute SMA_20 (placeholder - needs historical data implementation)
  const sma20 = await computeSMA20(env, symbol);
  
  let regime: MarketRegime;
  let flipped = false;
  
  if (sma20 === null) {
    // SMA unavailable - use NEUTRAL (allow both sides with caution)
    // Log this on first occurrence to make it clear regime detection is effectively disabled
    if (!previousRegime) {
      console.log('[regime] SMA20 unavailable, defaulting to NEUTRAL', JSON.stringify({
        symbol,
        currentPrice,
        note: 'Regime detection effectively disabled until computeSMA20 is implemented',
      }));
    }
    regime = 'NEUTRAL';
  } else {
    const priceVsSMA = (currentPrice - sma20) / sma20;
    
    if (priceVsSMA > 0.005) {
      // Price > SMA_20 by more than 0.5% → BULL
      regime = 'BULL';
    } else if (priceVsSMA < -0.005) {
      // Price < SMA_20 by more than 0.5% → BEAR
      regime = 'BEAR';
    } else {
      // Price within 0.5% of SMA_20 → NEUTRAL
      regime = 'NEUTRAL';
    }
    
    // Detect regime flip
    if (previousRegime && previousRegime !== 'NEUTRAL' && regime !== 'NEUTRAL' && previousRegime !== regime) {
      flipped = true;
      console.log('[regime][flip]', JSON.stringify({
        symbol,
        previous: previousRegime,
        current: regime,
        price: currentPrice,
        sma20,
        timestamp: new Date().toISOString(),
      }));
    }
  }
  
  // Store current regime
  await setSetting(env, previousRegimeKey, regime);
  
  return {
    regime,
    price: currentPrice,
    sma20,
    timestamp: new Date().toISOString(),
    previousRegime: previousRegime || undefined,
    flipped,
  };
}

/**
 * Get strategies enabled for current regime
 * 
 * Regime-based strategy gating:
 * - BULL: Enable bullish strategies (BULL_PUT_CREDIT, BULL_CALL_DEBIT)
 * - BEAR: Enable bearish strategies (BEAR_CALL_CREDIT, BEAR_PUT_DEBIT)
 * - NEUTRAL: Allow all strategies including IRON_CONDOR (range/trend agnostic)
 */
export function getStrategiesForRegime(regime: MarketRegime): {
  enabled: StrategyId[];
  disabled: StrategyId[];
} {
  if (regime === 'BULL') {
    return {
      enabled: [StrategyId.BULL_PUT_CREDIT, StrategyId.BULL_CALL_DEBIT],
      disabled: [StrategyId.BEAR_CALL_CREDIT, StrategyId.BEAR_PUT_DEBIT],
    };
  } else if (regime === 'BEAR') {
    return {
      enabled: [StrategyId.BEAR_CALL_CREDIT, StrategyId.BEAR_PUT_DEBIT],
      disabled: [StrategyId.BULL_PUT_CREDIT, StrategyId.BULL_CALL_DEBIT],
    };
  } else {
    // NEUTRAL: allow all strategies (but with extra caution)
    // IRON_CONDOR is range/trend agnostic, so it's only enabled in NEUTRAL
    return {
      enabled: [
        StrategyId.BULL_PUT_CREDIT,
        StrategyId.BULL_CALL_DEBIT,
        StrategyId.BEAR_CALL_CREDIT,
        StrategyId.BEAR_PUT_DEBIT,
        StrategyId.IRON_CONDOR,
      ],
      disabled: [],
    };
  }
}

/**
 * Check if a strategy is allowed in current regime
 */
export function isStrategyAllowedInRegime(
  strategy: StrategyId,
  regime: MarketRegime
): boolean {
  const { enabled } = getStrategiesForRegime(regime);
  return enabled.includes(strategy);
}

// Note: computeSMA20 is imported from core/trend.ts to ensure regime detection
// and trend filtering use the same SMA calculation logic.

