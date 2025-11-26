/**
 * Strategy Configuration
 * 
 * Defines configuration for each strategy type, including enablement flags,
 * symbol lists, DTE windows, delta ranges, and other parameters.
 */

import { StrategyId } from './types';
import type { TradingMode } from '../core/config';

// Re-export StrategyId for convenience
export { StrategyId } from './types';

export interface StrategyConfig {
  id: StrategyId;
  label: string;
  enabledPaper: boolean;
  enabledLive: boolean;
  symbols: string[];
  dte: { min: number; max: number };
  width: number; // Spread width in points (currently 5 for all strategies)
  // Delta range semantics:
  // - For calls: positive values (e.g., 0.20-0.35, 0.40-0.55)
  // - For credit put spreads (BULL_PUT_CREDIT): negative values (e.g., -0.32 to -0.18), compared against raw delta
  // - For debit put spreads (BEAR_PUT_DEBIT): positive magnitudes (e.g., 0.40-0.55), compared against abs(delta)
  targetDeltaRange: { min: number; max: number };
  // Minimum credit as fraction of width (e.g., 0.16 = 16% of width = 0.80 for width=5)
  // For debit spreads, this is ignored (not applicable)
  minCreditFraction: number;
  maxVerticalSkewSandbox: number;
  maxVerticalSkewLive: number;
  // For IRON_CONDOR only:
  minShortStrikeGap?: number;
}

export const STRATEGY_CONFIGS: Record<StrategyId, StrategyConfig> = {
  [StrategyId.BULL_PUT_CREDIT]: {
    id: StrategyId.BULL_PUT_CREDIT,
    label: 'Bull Put Credit',
    enabledPaper: true,
    enabledLive: true,
    symbols: ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'],
    dte: { min: 28, max: 38 },
    width: 5,
    targetDeltaRange: { min: -0.32, max: -0.18 }, // Negative for puts (compared against raw delta)
    minCreditFraction: 0.16, // 16% of width (5) = 0.80 min credit per spread
    maxVerticalSkewSandbox: 0.10,
    maxVerticalSkewLive: 0.05,
  },

  [StrategyId.BEAR_CALL_CREDIT]: {
    id: StrategyId.BEAR_CALL_CREDIT,
    label: 'Bear Call Credit',
    enabledPaper: true,
    enabledLive: false,
    symbols: ['SPY', 'AAPL', 'MSFT', 'QQQ', 'NVDA', 'AMD'],
    dte: { min: 28, max: 38 },
    width: 5,
    targetDeltaRange: { min: 0.20, max: 0.35 }, // Positive for calls
    minCreditFraction: 0.16, // 16% of width (5) = 0.80 min credit per spread
    maxVerticalSkewSandbox: 0.10,
    maxVerticalSkewLive: 0.05,
  },

  [StrategyId.BULL_CALL_DEBIT]: {
    id: StrategyId.BULL_CALL_DEBIT,
    label: 'Bull Call Debit',
    enabledPaper: true,
    enabledLive: true,
    symbols: ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'],
    dte: { min: 30, max: 35 },
    width: 5,
    targetDeltaRange: { min: 0.40, max: 0.55 }, // Positive for calls (long leg)
    minCreditFraction: 0.16, // Ignored for debit spreads (credit-only guardrail, required by interface)
    maxVerticalSkewSandbox: 0.10,
    maxVerticalSkewLive: 0.05,
  },

  [StrategyId.BEAR_PUT_DEBIT]: {
    id: StrategyId.BEAR_PUT_DEBIT,
    label: 'Bear Put Debit',
    enabledPaper: true,
    enabledLive: true,
    symbols: ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'],
    dte: { min: 30, max: 35 },
    width: 5,
    targetDeltaRange: { min: 0.40, max: 0.55 }, // For puts, we check abs(delta) in this range (positive magnitudes)
    minCreditFraction: 0.16, // Ignored for debit spreads (credit-only guardrail, required by interface)
    maxVerticalSkewSandbox: 0.10,
    maxVerticalSkewLive: 0.05,
  },

  [StrategyId.IRON_CONDOR]: {
    id: StrategyId.IRON_CONDOR,
    label: 'Iron Condor',
    enabledPaper: true,
    enabledLive: false,
    symbols: ['SPY', 'AAPL', 'MSFT', 'QQQ', 'NVDA', 'AMD'],
    dte: { min: 28, max: 38 },
    width: 5,
    targetDeltaRange: { min: -0.32, max: -0.18 }, // Not used for condors, but required by interface
    minCreditFraction: 0.16, // 16% of width (5) = 0.80 min credit per spread
    maxVerticalSkewSandbox: 0.10,
    maxVerticalSkewLive: 0.05,
    minShortStrikeGap: 10, // Put short strike at least 10 points below call short strike
  },
};

/**
 * Check if a strategy is enabled for a given trading mode
 * 
 * Helper function to keep enablement logic consistent and reusable.
 * - LIVE mode: uses enabledLive flag
 * - SANDBOX_PAPER / DRY_RUN: uses enabledPaper flag
 */
export function isStrategyEnabled(strategyId: StrategyId, mode: TradingMode): boolean {
  const config = STRATEGY_CONFIGS[strategyId];
  if (!config) {
    return false;
  }
  if (mode === 'LIVE') {
    return config.enabledLive;
  }
  // SANDBOX_PAPER and DRY_RUN both use enabledPaper flag
  return config.enabledPaper;
}

/**
 * Get enabled strategies for a given trading mode
 */
export function getEnabledStrategies(mode: TradingMode): StrategyId[] {
  const enabled: StrategyId[] = [];
  
  for (const strategyId of Object.keys(STRATEGY_CONFIGS) as StrategyId[]) {
    if (isStrategyEnabled(strategyId, mode)) {
      enabled.push(strategyId);
    }
  }
  
  return enabled;
}

/**
 * Get strategy config for a given strategy ID
 */
export function getStrategyConfig(strategyId: StrategyId): StrategyConfig {
  const config = STRATEGY_CONFIGS[strategyId];
  if (!config) {
    throw new Error(`Unknown strategy: ${strategyId}`);
  }
  return config;
}

