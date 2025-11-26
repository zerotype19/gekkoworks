/**
 * SAS v1 Configuration Helpers
 * 
 * Single source of truth for system configuration.
 */

import type { Env } from '../env';
import { getSetting } from '../db/queries';
import { StrategyId } from '../strategy/types';

export type TradingMode = 'DRY_RUN' | 'SANDBOX_PAPER' | 'LIVE';

// Valid trading modes - use this for validation, tests, health endpoints, etc.
export const TRADING_MODES: TradingMode[] = ['DRY_RUN', 'SANDBOX_PAPER', 'LIVE'];

export interface StrategyThresholds {
  minScore: number;
  minCreditFraction: number; // fraction of width (e.g. 0.20 = 20% of width)
  minDte: number;
  maxDte: number;
  minDelta: number; // minimum delta for short put (e.g. -0.30)
  maxDelta: number; // maximum delta for short put (e.g. -0.20)
}

export interface ExitRuleThresholds {
  // NOTE: profitTargetFraction and stopLossFraction are returned here but NOT used by evaluateCloseRules
  // evaluateCloseRules re-reads settings directly and applies debit/credit-specific defaults
  // These fields are kept for backward compatibility but should be considered legacy
  profitTargetFraction: number; // Default 0.50 (50% of max profit) - NOT USED by close rules
  stopLossFraction: number; // Default 0.10 (10% of max loss) - NOT USED by close rules
  timeExitDteThreshold: number; // DTE <= 2 (default)
  timeExitCutoff: string; // "15:50" ET as HH:MM (default)
  ivCrushThreshold: number; // IV_now <= IV_entry * 0.85 (default)
  ivCrushMinPnL: number; // PnL >= +15% to trigger IV crush (default)
  trailArmProfitFraction: number; // Start trailing once we hit +25% (default)
  trailGivebackFraction: number; // Close if we give back 10% from peak (default)
}

/**
 * Get current trading mode
 * 
 * Defaults to DRY_RUN if not set or invalid.
 */
export async function getTradingMode(env: Env): Promise<TradingMode> {
  const value = await getSetting(env, 'TRADING_MODE');
  
  if (value === 'SANDBOX_PAPER' || value === 'LIVE') {
    return value;
  }
  
  // Default to DRY_RUN for safety
  return 'DRY_RUN';
}

/**
 * Get auto mode enabled status for current trading mode
 */
export async function isAutoModeEnabled(env: Env): Promise<boolean> {
  const mode = await getTradingMode(env);
  
  if (mode === 'SANDBOX_PAPER') {
    return (await getSetting(env, 'AUTO_MODE_ENABLED_PAPER')) === 'true';
  }
  
  if (mode === 'LIVE') {
    return (await getSetting(env, 'AUTO_MODE_ENABLED_LIVE')) === 'true';
  }
  
  // DRY_RUN never has auto mode enabled
  return false;
}

/**
 * Get minimum score threshold for current trading mode
 * 
 * Precedence:
 * 1) MIN_SCORE_PAPER / MIN_SCORE_LIVE (mode-specific)
 * 2) PROPOSAL_MIN_SCORE (shared fallback)
 * 3) Hardcoded 70 (DRY_RUN only, or if all settings missing)
 */
export async function getMinScore(env: Env): Promise<number> {
  const mode = await getTradingMode(env);
  
  if (mode === 'SANDBOX_PAPER') {
    const value = await getSetting(env, 'MIN_SCORE_PAPER');
    if (value) {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    // Fallback to shared PROPOSAL_MIN_SCORE or default 70
    const fallback = parseFloat((await getSetting(env, 'PROPOSAL_MIN_SCORE')) || '70');
    if (!value) {
      console.log('[config] min score fallback to PROPOSAL_MIN_SCORE or 70', { mode, fallback });
    }
    return fallback;
  }
  
  if (mode === 'LIVE') {
    const value = await getSetting(env, 'MIN_SCORE_LIVE');
    if (value) {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    // Fallback to shared PROPOSAL_MIN_SCORE or default 70
    const fallback = parseFloat((await getSetting(env, 'PROPOSAL_MIN_SCORE')) || '70');
    if (!value) {
      console.log('[config] min score fallback to PROPOSAL_MIN_SCORE or 70', { mode, fallback });
    }
    return fallback;
  }
  
  // DRY_RUN uses strict thresholds (hardcoded 70, no config override)
  return 70;
}

/**
 * Helper to parse numeric settings with validation and fallback
 */
async function getNumberSetting(env: Env, key: string, fallback: number): Promise<number> {
  const raw = await getSetting(env, key);
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn('[config] invalid numeric setting, using fallback', { key, raw, fallback });
    return fallback;
  }
  return parsed;
}

/**
 * Get strategy thresholds based on trading mode
 * 
 * NOTE: This function provides BULL_PUT_CREDIT-like defaults for global proposal thresholds.
 * Per-strategy configs (STRATEGY_CONFIGS) override these at the builder level.
 * 
 * To avoid drift, consider deriving these from STRATEGY_CONFIGS[StrategyId.BULL_PUT_CREDIT]
 * in the future, or explicitly mark this as "BULL_PUT_CREDIT-only global thresholds".
 */
export async function getStrategyThresholds(env: Env): Promise<StrategyThresholds> {
  const mode = await getTradingMode(env);
  const minScore = await getMinScore(env);

  // DTE window configurable via PROPOSAL_DTE_MIN and PROPOSAL_DTE_MAX, defaults to 30-35
  const minDte = parseInt((await getSetting(env, 'PROPOSAL_DTE_MIN')) || '30');
  const maxDte = parseInt((await getSetting(env, 'PROPOSAL_DTE_MAX')) || '35');
  
  // Get min credit fraction from config, default 0.16 (16% of width = $0.80 for 5-wide)
  const minCreditFraction = await getNumberSetting(env, 'MIN_CREDIT_FRACTION', 0.16);
  
  // NOTE: Delta range hard-coded here for BULL_PUT_CREDIT defaults
  // Per-strategy configs in STRATEGY_CONFIGS override these at builder level
  // Consider deriving from STRATEGY_CONFIGS to avoid duplication
  return {
    minScore,
    minCreditFraction,
    minDte,
    maxDte,
    // Delta range: -0.18 to -0.32 for short put (BULL_PUT_CREDIT defaults)
    minDelta: -0.32,
    maxDelta: -0.18,
  };
}

/**
 * Get strategy whitelist
 * 
 * Returns list of allowed strategies, or empty array if no whitelist configured.
 * Validates against StrategyId enum to prevent typos and mismatches.
 */
export async function getStrategyWhitelist(env: Env): Promise<StrategyId[]> {
  const whitelist = await getSetting(env, 'PROPOSAL_STRATEGY_WHITELIST');
  if (!whitelist) {
    return []; // No whitelist = allow all
  }
  
  // Parse comma-separated list and validate against StrategyId enum
  const values = whitelist
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  
  const validStrategies = new Set<StrategyId>();
  
  for (const value of values) {
    // Check if value matches a StrategyId enum value
    const strategyId = Object.values(StrategyId).find(id => id === value);
    if (strategyId) {
      validStrategies.add(strategyId);
    } else {
      console.warn('[config] invalid strategy in whitelist, ignoring', { raw: value, validValues: Object.values(StrategyId) });
    }
  }
  
  return Array.from(validStrategies);
}

/**
 * Get underlying whitelist
 * 
 * Returns list of allowed underlying symbols, or empty array if no whitelist configured.
 */
export async function getUnderlyingWhitelist(env: Env): Promise<string[]> {
  const whitelist = await getSetting(env, 'PROPOSAL_UNDERLYING_WHITELIST');
  if (!whitelist) {
    return []; // No whitelist = allow all
  }
  
  // Parse comma-separated list (e.g., "SPY,QQQ")
  return whitelist.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length > 0);
}

/**
 * Get exit rule thresholds from config
 * 
 * All thresholds are configurable via settings table with sensible defaults.
 * 
 * NOTE: profitTargetFraction and stopLossFraction are returned but NOT used by evaluateCloseRules.
 * evaluateCloseRules re-reads settings directly and applies debit/credit-specific defaults.
 * Only ivCrushThreshold, ivCrushMinPnL, trailArmProfitFraction, trailGivebackFraction,
 * timeExitDteThreshold, and timeExitCutoff are actually used.
 */
export async function getExitRuleThresholds(env: Env): Promise<ExitRuleThresholds> {
  return {
    // Legacy fields - not used by evaluateCloseRules (kept for backward compatibility)
    profitTargetFraction: await getNumberSetting(env, 'CLOSE_RULE_PROFIT_TARGET_FRACTION', 0.50),
    stopLossFraction: await getNumberSetting(env, 'CLOSE_RULE_STOP_LOSS_FRACTION', 0.10),
    // Active fields - used by evaluateCloseRules
    timeExitDteThreshold: parseInt(
      (await getSetting(env, 'CLOSE_RULE_TIME_EXIT_DTE')) || '2'
    ),
    timeExitCutoff: (await getSetting(env, 'CLOSE_RULE_TIME_EXIT_CUTOFF')) || '15:50',
    ivCrushThreshold: await getNumberSetting(env, 'CLOSE_RULE_IV_CRUSH_THRESHOLD', 0.85),
    ivCrushMinPnL: await getNumberSetting(env, 'CLOSE_RULE_IV_CRUSH_MIN_PNL', 0.15),
    trailArmProfitFraction: await getNumberSetting(env, 'CLOSE_RULE_TRAIL_ARM_PROFIT_FRACTION', 0.25),
    trailGivebackFraction: await getNumberSetting(env, 'CLOSE_RULE_TRAIL_GIVEBACK_FRACTION', 0.10),
  };
}

/**
 * Get default trade quantity from config
 * 
 * Configurable via DEFAULT_TRADE_QUANTITY setting, defaults to 1.
 */
export async function getDefaultTradeQuantity(env: Env): Promise<number> {
  const value = await getSetting(env, 'DEFAULT_TRADE_QUANTITY');
  if (value) {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed > 0) {
      // Cap at MAX_TRADE_QUANTITY if set
      const maxQuantity = parseInt(
        (await getSetting(env, 'MAX_TRADE_QUANTITY')) || '10',
        10
      ) || 10;
      return Math.min(parsed, maxQuantity);
    }
  }
  return 1; // Default to 1 contract
}

