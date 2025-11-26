/**
 * Debug endpoint: /debug/strategy-status
 * 
 * Returns detailed status for each strategy including:
 * - Enabled/disabled by regime
 * - Current exposure
 * - Risk allocation
 * - Whether it would be allowed to open a trade
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { detectRegime, getStrategiesForRegime, isStrategyAllowedInRegime } from '../core/regime';
import {
  computeBullishExposure,
  computeBearishExposure,
  validateGlobalBullRiskCap,
  validateGlobalBearRiskCap,
  validateBullTradeCounts,
  validateBearTradeCounts,
} from '../core/risk';
import { getTradingMode } from '../core/config';
import { StrategyId, getEnabledStrategies, getStrategyConfig } from '../strategy/config';
import { getOpenTrades, getSetting } from '../db/queries';

export async function handleDebugStrategyStatus(env: Env): Promise<Response> {
  try {
    const mode = await getTradingMode(env);
    const broker = new TradierClient(env);
    const symbol = 'SPY';
    
    // Get current regime
    const underlying = await broker.getUnderlyingQuote(symbol);
    const regimeState = await detectRegime(env, symbol, underlying.last);
    const { enabled: regimeEnabledStrategies } = getStrategiesForRegime(regimeState.regime);
    
    // Get enabled strategies for mode
    const modeEnabledStrategies = getEnabledStrategies(mode);
    
    // Get current exposures
    const bullExposure = await computeBullishExposure(env);
    const bearExposure = await computeBearishExposure(env);
    
    // Get open trades by strategy
    const openTrades = await getOpenTrades(env);
    const tradesByStrategy: Record<string, number> = {};
    for (const trade of openTrades) {
      const strategy = trade.strategy || 'UNKNOWN';
      tradesByStrategy[strategy] = (tradesByStrategy[strategy] || 0) + (trade.quantity || 1);
    }
    
    // Get risk caps and limits (do this once, not in map)
    const bullRiskCap = parseFloat((await getSetting(env, 'GLOBAL_BULL_RISK_CAP')) || '2500');
    const bearRiskCap = parseFloat((await getSetting(env, 'GLOBAL_BEAR_RISK_CAP')) || '2500');
    const maxBullTrades = parseInt((await getSetting(env, 'MAX_BULL_TRADES')) || '3');
    const maxBearTrades = parseInt((await getSetting(env, 'MAX_BEAR_TRADES')) || '3');
    const maxDebitTrades = parseInt((await getSetting(env, 'MAX_DEBIT_TRADES')) || '1');
    const maxDebitBearTrades = parseInt((await getSetting(env, 'MAX_DEBIT_BEAR_TRADES')) || '1');
    
    // Build status for each strategy
    const strategies = [
      { id: StrategyId.BULL_PUT_CREDIT, name: 'BULL_PUT_CREDIT' },
      { id: StrategyId.BULL_CALL_DEBIT, name: 'BULL_CALL_DEBIT' },
      { id: StrategyId.BEAR_CALL_CREDIT, name: 'BEAR_CALL_CREDIT' },
      { id: StrategyId.BEAR_PUT_DEBIT, name: 'BEAR_PUT_DEBIT' },
    ];
    
    const strategyStatuses = strategies.map(({ id, name }) => {
      const config = getStrategyConfig(id);
      const enabledByMode = modeEnabledStrategies.includes(id);
      // Use id (StrategyId enum) instead of name (string) for type safety
      const enabledByRegime = isStrategyAllowedInRegime(id, regimeState.regime);
      const enabledOverall = enabledByMode && enabledByRegime;
      
      // Determine if it's a bull or bear strategy
      const isBullish = name === 'BULL_PUT_CREDIT' || name === 'BULL_CALL_DEBIT';
      const isDebit = name === 'BULL_CALL_DEBIT' || name === 'BEAR_PUT_DEBIT';
      
      // Get exposure for this strategy type (use separate variables to avoid type narrowing issues)
      const riskCap = isBullish ? bullRiskCap : bearRiskCap;
      const maxTrades = isBullish ? maxBullTrades : maxBearTrades;
      const maxDebitTradesForStrategy = isBullish ? maxDebitTrades : maxDebitBearTrades;
      
      // Extract exposure values based on strategy type
      const creditRisk = isBullish ? bullExposure.bull_credit_risk : bearExposure.bear_credit_risk;
      const debitRisk = isBullish ? bullExposure.bull_debit_risk : bearExposure.bear_debit_risk;
      const totalRisk = isBullish ? bullExposure.bull_total_risk : bearExposure.bear_total_risk;
      const tradeCount = isBullish ? bullExposure.bull_trade_count : bearExposure.bear_trade_count;
      const debitCount = isBullish ? bullExposure.debit_trade_count : bearExposure.debit_trade_count;
      
      // Check if a new trade would be allowed (hypothetical $500 max_loss trade)
      const hypotheticalMaxLoss = 500;
      let wouldAllowNewTrade = false;
      let blockReason: string | null = null;
      
      if (!enabledOverall) {
        blockReason = enabledByMode ? 'DISABLED_BY_REGIME' : 'DISABLED_BY_MODE';
      } else {
        // Check risk cap
        const weightedRisk = isDebit ? hypotheticalMaxLoss * 1.5 : hypotheticalMaxLoss * 1.0;
        const totalAfterNew = totalRisk + weightedRisk;
        if (totalAfterNew > riskCap) {
          blockReason = 'RISK_CAP_EXCEEDED';
        } else if (tradeCount >= maxTrades) {
          blockReason = 'MAX_TRADES_EXCEEDED';
        } else if (isDebit && debitCount >= maxDebitTradesForStrategy) {
          blockReason = 'MAX_DEBIT_TRADES_EXCEEDED';
        } else {
          wouldAllowNewTrade = true;
        }
      }
      
      return {
        strategy: name,
        enabled_by_mode: enabledByMode,
        enabled_by_regime: enabledByRegime,
        enabled_overall: enabledOverall,
        current_trade_count: tradesByStrategy[name] || 0,
        exposure: {
          credit_risk: creditRisk,
          debit_risk: debitRisk,
          total_weighted_risk: totalRisk,
          risk_cap: riskCap,
          risk_remaining: Math.max(0, riskCap - totalRisk),
          trade_count: tradeCount,
          max_trades: maxTrades,
          debit_count: debitCount,
          max_debit_trades: maxDebitTradesForStrategy,
        },
        would_allow_new_trade: wouldAllowNewTrade,
        block_reason: blockReason,
      };
    });
    
    const response = {
      regime: {
        current: regimeState.regime,
        price: underlying.last,
        sma20: regimeState.sma20,
        flipped: regimeState.flipped,
      },
      strategies: strategyStatuses,
      summary: {
        total_bull_exposure: bullExposure.bull_total_risk,
        total_bear_exposure: bearExposure.bear_total_risk,
        total_bull_trades: bullExposure.bull_trade_count,
        total_bear_trades: bearExposure.bear_trade_count,
      },
      timestamp: new Date().toISOString(),
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[debug][strategy-status][error]', error);
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

