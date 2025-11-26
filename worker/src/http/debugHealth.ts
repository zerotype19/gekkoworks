/**
 * Health/Diagnostic Endpoint
 * 
 * Provides a comprehensive snapshot of system health including:
 * - Current config values
 * - Portfolio summary
 * - Engine heartbeat
 */

import type { Env } from '../env';
import { getStrategyThresholds, getExitRuleThresholds, getTradingMode } from '../core/config';
import { getOpenTrades, getSetting } from '../db/queries';
import { repairPortfolio } from '../engine/monitoring';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugHealth(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  const results: Record<string, any> = {
    timestamp: now.toISOString(),
    config: {},
    portfolio: {},
    engine: {},
  };

  try {
    // 1. Current config values
    const thresholds = await getStrategyThresholds(env);
    const exitRules = await getExitRuleThresholds(env);
    
    results.config = {
      dte: {
        min: thresholds.minDte,
        max: thresholds.maxDte,
      },
      delta: {
        min: thresholds.minDelta,
        max: thresholds.maxDelta,
      },
      exitRules: {
        profitTargetFraction: exitRules.profitTargetFraction,
        stopLossFraction: exitRules.stopLossFraction,
        timeExitDteThreshold: exitRules.timeExitDteThreshold,
        timeExitCutoff: exitRules.timeExitCutoff,
        ivCrushThreshold: exitRules.ivCrushThreshold,
        ivCrushMinPnL: exitRules.ivCrushMinPnL,
      },
    };

    // 2. Portfolio summary (from our DB, not Tradier)
    const openTrades = await getOpenTrades(env);
    
    // Compute net premium (credit - debit) across all OPEN trades
    let netPremium = 0;
    for (const trade of openTrades) {
      if (trade.entry_price && trade.entry_price > 0) {
        // For bull put credit spread: entry_price is credit received
        netPremium += trade.entry_price * 100; // Convert to dollars
      }
    }
    
    // Check structural validity (using same logic as repairPortfolio)
    const broker = new TradierClient(env);
    let validCount = 0;
    let invalidCount = 0;
    
    for (const trade of openTrades) {
      if (!trade.entry_price || trade.entry_price <= 0) {
        invalidCount++;
        continue;
      }
      
      try {
        // Quick structural check: strikes match pattern
        const expectedLongStrike = trade.short_strike - trade.width;
        if (Math.abs(trade.long_strike - expectedLongStrike) > 0.01 || trade.width !== 5) {
          invalidCount++;
        } else {
          validCount++;
        }
      } catch (error) {
        invalidCount++;
      }
    }
    
    results.portfolio = {
      openSpreads: {
        total: openTrades.length,
        valid: validCount,
        invalid: invalidCount,
      },
      netPremium: {
        dollars: netPremium,
        formatted: `$${netPremium.toFixed(2)}`,
      },
    };

    // 3. Engine heartbeat
    const lastProposalRun = await getSetting(env, 'LAST_PROPOSAL_RUN');
    const lastMonitorRun = await getSetting(env, 'LAST_MONITOR_RUN');
    const autoModeEnabled = (await getSetting(env, 'AUTO_MODE_ENABLED')) === 'true';
    
    results.engine = {
      autoModeEnabled,
      lastProposalRun: lastProposalRun || null,
      lastMonitorRun: lastMonitorRun || null,
      tradingMode: await getTradingMode(env),
    };

    return new Response(
      JSON.stringify(results, null, 2),
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

