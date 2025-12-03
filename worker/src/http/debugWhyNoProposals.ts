/**
 * Debug endpoint to diagnose why no proposals were generated today
 * 
 * GET /debug/why-no-proposals
 * Returns comprehensive diagnostic information about proposal generation blockers
 */

import type { Env } from '../env';
import { getSetting, getRecentSystemLogs, getOpenTrades } from '../db/queries';
import { canOpenNewTrade } from '../core/risk';
import { isMarketHours, isTradingDay } from '../core/time';
import { getTradingMode, getStrategyThresholds, type TradingMode } from '../core/config';
import { getRiskSnapshot } from '../core/risk';
// Note: getEligibleSymbols is not exported, so we'll replicate the logic here
async function getEligibleSymbols(env: Env, mode: TradingMode): Promise<string[]> {
  const { getUnderlyingWhitelist } = await import('../core/config');
  
  let baseSymbols: string[];
  if (mode === 'SANDBOX_PAPER') {
    baseSymbols = ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'];
  } else if (mode === 'LIVE') {
    baseSymbols = ['SPY'];
  } else {
    baseSymbols = ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'];
  }
  
  const whitelist = await getUnderlyingWhitelist(env);
  if (whitelist.length > 0) {
    return baseSymbols.filter(s => whitelist.includes(s.toUpperCase()));
  }
  return baseSymbols;
}
import { getEnabledStrategies } from '../strategy/config';

export async function handleDebugWhyNoProposals(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    // 1. Check if tradeCycle ran today
    const lastHeartbeat = await getSetting(env, 'LAST_TRADE_CYCLE_HEARTBEAT');
    const lastProposalRun = await getSetting(env, 'LAST_PROPOSAL_RUN');
    const lastError = await getSetting(env, 'LAST_TRADE_CYCLE_ERROR');
    
    // 2. Check all potential blockers
    const tradingDay = isTradingDay(now);
    const marketHours = isMarketHours(now);
    const tradingMode = await getTradingMode(env);
    const riskSnapshot = await getRiskSnapshot(env, now);
    const canOpen = await canOpenNewTrade(env, now);
    const openTrades = await getOpenTrades(env);
    const maxOpenPositions = parseInt(
      (await getSetting(env, 'MAX_OPEN_POSITIONS')) || '10',
      10
    );
    
    // 3. Check proposal generation blockers
    const eligibleSymbols = await getEligibleSymbols(env, tradingMode);
    const enabledStrategies = getEnabledStrategies(tradingMode);
    
    // Check strategy whitelist
    const { getStrategyWhitelist } = await import('../core/config');
    const strategyWhitelist = await getStrategyWhitelist(env);
    const strategiesAfterWhitelist = strategyWhitelist.length > 0
      ? enabledStrategies.filter(s => strategyWhitelist.includes(s))
      : enabledStrategies;
    
    // Check underlying whitelist
    const { getUnderlyingWhitelist } = await import('../core/config');
    const underlyingWhitelist = await getUnderlyingWhitelist(env);
    
    // 4. Get recent proposal summaries from logs
    const systemLogs = await getRecentSystemLogs(env, 1000);
    const todayLogs = systemLogs.filter(log => {
      const logDate = new Date(log.created_at);
      return logDate.toDateString() === now.toDateString();
    });
    
    const proposalSummaries = todayLogs
      .filter(log => log.message === '[proposals] summary' && log.details)
      .map(log => {
        try {
          return JSON.parse(log.details || '{}');
        } catch {
          return null;
        }
      })
      .filter((s): s is any => s !== null);
    
    const tradeCycleLogs = todayLogs
      .filter(log => log.log_type === 'tradeCycle')
      .slice(0, 20);
    
    // 5. Check RV/IV ratio (this could block all proposals)
    const thresholds = await getStrategyThresholds(env);
    const rv_30d = 0.15; // Placeholder
    const iv_30d = 0.20; // Placeholder
    const { isRVIVRatioValid } = await import('../core/metrics');
    const rvIvValid = isRVIVRatioValid(rv_30d, iv_30d);
    const rvIvRatio = rv_30d / iv_30d;
    
    // 6. Determine blockers
    const blockers: Array<{ type: string; reason: string; details?: any }> = [];
    
    if (!tradingDay) {
      blockers.push({ type: 'NOT_TRADING_DAY', reason: 'Today is not a trading day' });
    }
    if (!marketHours) {
      blockers.push({ type: 'MARKET_CLOSED', reason: 'Market is currently closed' });
    }
    if (riskSnapshot.system_mode === 'HARD_STOP') {
      blockers.push({ type: 'HARD_STOP', reason: 'System is in HARD_STOP mode' });
    }
    if (riskSnapshot.risk_state !== 'NORMAL') {
      blockers.push({ 
        type: 'RISK_STATE', 
        reason: `Risk state is ${riskSnapshot.risk_state} (not NORMAL)`,
        details: riskSnapshot
      });
    }
    if (!canOpen) {
      blockers.push({ type: 'CANNOT_OPEN_NEW_TRADE', reason: 'Risk gates prevent opening new trades' });
    }
    if (openTrades.length >= maxOpenPositions) {
      blockers.push({ 
        type: 'MAX_POSITIONS_REACHED', 
        reason: `Already have ${openTrades.length} open positions (max: ${maxOpenPositions})` 
      });
    }
    if (eligibleSymbols.length === 0) {
      blockers.push({ 
        type: 'NO_ELIGIBLE_SYMBOLS', 
        reason: 'No eligible symbols (whitelist may be too restrictive)',
        details: {
          underlying_whitelist: underlyingWhitelist,
          trading_mode: tradingMode,
        }
      });
    }
    if (strategiesAfterWhitelist.length === 0) {
      blockers.push({ 
        type: 'NO_ENABLED_STRATEGIES', 
        reason: 'No enabled strategies after whitelist filtering',
        details: {
          enabled_strategies: enabledStrategies,
          strategy_whitelist: strategyWhitelist,
          strategies_after_whitelist: strategiesAfterWhitelist,
        }
      });
    }
    if (!rvIvValid && tradingMode !== 'SANDBOX_PAPER') {
      blockers.push({ 
        type: 'RV_IV_RATIO_INVALID', 
        reason: `RV/IV ratio invalid (${rvIvRatio.toFixed(3)}) - blocks all proposals in ${tradingMode} mode`,
        details: {
          rv_30d,
          iv_30d,
          ratio: rvIvRatio,
          valid: rvIvValid,
          mode: tradingMode,
        }
      });
    }
    
    // 7. Analyze recent proposal summaries
    const latestSummary = proposalSummaries[0];
    const reasonsFromSummaries: string[] = [];
    if (latestSummary) {
      if (latestSummary.candidateCount === 0) {
        reasonsFromSummaries.push('NO_CANDIDATES_BUILT - No candidates were built for any symbol/strategy');
      }
      if (latestSummary.scoredCount === 0 && latestSummary.candidateCount > 0) {
        reasonsFromSummaries.push('NO_CANDIDATES_SCORED - Candidates built but none passed hard filters');
      }
      if (latestSummary.passingCount === 0 && latestSummary.scoredCount > 0) {
        reasonsFromSummaries.push('NO_CANDIDATES_PASSED_SCORE_THRESHOLD - All candidates scored below threshold');
      }
      if (latestSummary.bestScore !== null && latestSummary.bestScore < latestSummary.minScoreThreshold) {
        reasonsFromSummaries.push(`BEST_SCORE_BELOW_THRESHOLD - Best score ${latestSummary.bestScore} < ${latestSummary.minScoreThreshold}`);
      }
    }
    
    return new Response(
      JSON.stringify({
        timestamp: now.toISOString(),
        diagnostic: {
          trade_cycle_status: {
            last_heartbeat: lastHeartbeat,
            last_proposal_run: lastProposalRun,
            last_error: lastError || null,
            ran_today: lastHeartbeat ? new Date(lastHeartbeat).toDateString() === now.toDateString() : false,
          },
          current_checks: {
            trading_day: tradingDay,
            market_hours: marketHours,
            trading_mode: tradingMode,
            system_mode: riskSnapshot.system_mode,
            risk_state: riskSnapshot.risk_state,
            can_open_new_trade: canOpen,
            open_positions: openTrades.length,
            max_open_positions: maxOpenPositions,
            positions_at_max: openTrades.length >= maxOpenPositions,
          },
          proposal_generation_checks: {
            eligible_symbols: eligibleSymbols,
            underlying_whitelist: underlyingWhitelist,
            enabled_strategies: enabledStrategies,
            strategy_whitelist: strategyWhitelist,
            strategies_after_whitelist: strategiesAfterWhitelist,
            rv_iv_check: {
              rv_30d,
              iv_30d,
              ratio: rvIvRatio,
              valid: rvIvValid,
              mode: tradingMode,
              would_block: !rvIvValid && tradingMode !== 'SANDBOX_PAPER',
            },
            thresholds: {
              min_score: thresholds.minScore,
              min_credit_fraction: thresholds.minCreditFraction,
              min_dte: thresholds.minDte,
              max_dte: thresholds.maxDte,
            },
          },
          blockers,
          recent_proposal_summaries: proposalSummaries.slice(0, 10).map((summary, idx) => ({
            index: idx + 1,
            timestamp: todayLogs.find(log => log.message === '[proposals] summary')?.created_at,
            candidate_count: summary.candidateCount || 0,
            scored_count: summary.scoredCount || 0,
            passing_count: summary.passingCount || 0,
            best_score: summary.bestScore,
            min_score_threshold: summary.minScoreThreshold,
            reason: summary.reason,
            filter_rejections: summary.filterRejections || {},
            scoring_rejections: summary.scoringRejections || {},
          })),
          reasons_from_summaries: reasonsFromSummaries,
          recent_trade_cycle_logs: tradeCycleLogs.slice(0, 10).map(log => ({
            timestamp: log.created_at,
            message: log.message,
            details: log.details,
          })),
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

