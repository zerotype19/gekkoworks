/**
 * SAS v1 Premarket Health Check
 * 
 * Runs before market open to validate system readiness.
 * Per architecture.md and risk-management.md.
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getSetting, getRiskState, setRiskState, setSetting } from '../db/queries';
import { isTradingDay } from '../core/time';
import { computeDTE, isDTEInWindow } from '../core/time';
import { syncBalancesFromTradier } from '../engine/balancesSync';

/**
 * Run premarket health check
 * 
 * Per system-interfaces.md:
 * export async function runPremarketCheck(env: Env, now: Date): Promise<void>;
 */
export async function runPremarketCheck(env: Env, now: Date): Promise<void> {
  try {
    // 1. Check if it's a trading day
    if (!isTradingDay(now)) {
      return; // Not a trading day, skip check
    }
    
    // 2. Check system mode
    const systemMode = (await getRiskState(env, 'SYSTEM_MODE')) || 'NORMAL';
    if (systemMode === 'HARD_STOP') {
      // System in hard stop - don't reset, just log
      return;
    }
    
    // 3. Sync balances from Tradier (per Tradier-first spec)
    try {
      const balancesSyncResult = await syncBalancesFromTradier(env);
      if (!balancesSyncResult.success) {
        throw new Error(`Balances sync failed: ${balancesSyncResult.errors.join(', ')}`);
      }
      console.log('[premarket] balances synced', JSON.stringify({
        cash: balancesSyncResult.balances?.cash,
        buying_power: balancesSyncResult.balances?.buying_power,
        equity: balancesSyncResult.balances?.equity,
      }));
    } catch (error) {
      await setRiskState(env, 'RISK_STATE', 'PREMARKET_CHECK_FAILED');
      throw new Error(`Balances sync failed: ${error}`);
    }
    
    // 3.5. Check Tradier connectivity
    const broker = new TradierClient(env);
    try {
      const spyQuote = await broker.getUnderlyingQuote('SPY');
      if (!spyQuote.bid || !spyQuote.ask || !spyQuote.last) {
        throw new Error('SPY quote missing required fields');
      }
    } catch (error) {
      await setRiskState(env, 'RISK_STATE', 'PREMARKET_CHECK_FAILED');
      throw new Error(`Tradier connectivity check failed: ${error}`);
    }
    
    // 4. Check D1 database
    try {
      const testSetting = await getSetting(env, 'MAX_TRADES_PER_DAY');
      if (!testSetting) {
        throw new Error('D1 database not accessible or settings missing');
      }
    } catch (error) {
      await setRiskState(env, 'RISK_STATE', 'PREMARKET_CHECK_FAILED');
      throw new Error(`D1 database check failed: ${error}`);
    }
    
    // 5. Check critical settings
    const maxTrades = await getSetting(env, 'MAX_TRADES_PER_DAY');
    const maxLossPct = await getSetting(env, 'MAX_DAILY_LOSS_PCT');
    
    if (!maxTrades || !maxLossPct) {
      await setRiskState(env, 'RISK_STATE', 'PREMARKET_CHECK_FAILED');
      throw new Error('Critical settings missing');
    }
    
    // Validate settings are numeric
    if (isNaN(parseFloat(maxTrades)) || isNaN(parseFloat(maxLossPct))) {
      await setRiskState(env, 'RISK_STATE', 'PREMARKET_CHECK_FAILED');
      throw new Error('Critical settings invalid');
    }
    
    // 5.5. Initialize auto mode setting (defaults to false for safety)
    const autoModeEnabled = await getSetting(env, 'AUTO_MODE_ENABLED');
    if (!autoModeEnabled) {
      await setSetting(env, 'AUTO_MODE_ENABLED', 'false');
      console.log('[premarket] initialized AUTO_MODE_ENABLED = false (default for safety)');
    }
    
    // 5.6. Initialize exit rule settings if not present (Phase 2: config-driven exit rules)
    // Updated defaults per new spec: profit target 35%, stop loss -30%, time exit with 15:50 ET gate
    const exitRuleDefaults = {
      'CLOSE_RULE_STOP_LOSS_FRACTION': '-0.30', // -30% of max loss (was -50%)
      'CLOSE_RULE_PROFIT_TARGET_FRACTION': '0.35', // +35% of max gain (was 50%)
      'CLOSE_RULE_TRAILBACK_FRACTION': '0.15',
      'CLOSE_RULE_TIME_EXIT_DTE': '2',
      'CLOSE_RULE_TIME_EXIT_CUTOFF': '15:50', // ET time gate for time exit
      'CLOSE_RULE_LOW_VALUE_CLOSE_THRESHOLD': '0.05',
      'CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD': '0.30',
      'CLOSE_RULE_UNDERLYING_SPIKE_THRESHOLD': '0.005',
      'CLOSE_RULE_IV_CRUSH_THRESHOLD': '0.85', // IV drops to 85% of entry IV
      'CLOSE_RULE_IV_CRUSH_MIN_PNL': '0.15', // PnL >= +15% to trigger IV crush exit
    };
    
    for (const [key, defaultValue] of Object.entries(exitRuleDefaults)) {
      const existing = await getSetting(env, key);
      if (!existing) {
        await setSetting(env, key, defaultValue);
        console.log(`[premarket] initialized exit rule setting: ${key} = ${defaultValue}`);
      }
    }
    
    // 6. Check option chain availability (at least one valid expiration in DTE window)
    try {
      // Try to find an expiration in 30-35 DTE range
      // Calculate a potential expiration date
      const testDate = new Date(now);
      testDate.setDate(testDate.getDate() + 32); // ~32 days out
      
      // Find nearest Friday
      const dayOfWeek = testDate.getDay();
      const daysToFriday = (5 - dayOfWeek + 7) % 7;
      if (daysToFriday > 0) {
        testDate.setDate(testDate.getDate() + daysToFriday);
      }
      
      const expirationStr = testDate.toISOString().split('T')[0];
      const chain = await broker.getOptionChain('SPY', expirationStr);
      
      if (chain.length === 0) {
        // Try a different date
        testDate.setDate(testDate.getDate() + 7); // Next week
        const nextExpiration = testDate.toISOString().split('T')[0];
        const nextChain = await broker.getOptionChain('SPY', nextExpiration);
        
        if (nextChain.length === 0) {
          throw new Error('No option chains available for target DTE window');
        }
      }
    } catch (error) {
      await setRiskState(env, 'RISK_STATE', 'PREMARKET_CHECK_FAILED');
      throw new Error(`Option chain check failed: ${error}`);
    }
    
    // All checks passed - reset risk state if it was failed
    const currentRiskState = await getRiskState(env, 'RISK_STATE');
    if (currentRiskState === 'PREMARKET_CHECK_FAILED') {
      await setRiskState(env, 'RISK_STATE', 'NORMAL');
    }
    
  } catch (error) {
    // Error already logged and risk state set
    // Re-throw to ensure cron handler knows it failed
    throw error;
  }
}

