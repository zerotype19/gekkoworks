/**
 * Debug endpoint to check trade cycle status and potential blockers
 * 
 * GET /debug/trade-cycle-status
 * Returns detailed status of trade cycle blockers
 */

import type { Env } from '../env';
import { canOpenNewTrade } from '../core/risk';
import { getSetting, getOpenTrades, getRiskState } from '../db/queries';
import { isMarketHours, isTradingDay } from '../core/time';
import { getTradingMode } from '../core/config';
import { getRiskSnapshot } from '../core/risk';
import { syncPortfolioFromTradier } from '../engine/portfolioSync';
import { syncOrdersFromTradier } from '../engine/orderSync';
import { syncBalancesFromTradier } from '../engine/balancesSync';

export async function handleDebugTradeCycleStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const now = new Date();
    
    // Check all potential blockers
    const marketHours = isMarketHours(now);
    const tradingDay = isTradingDay(now);
    const tradingMode = await getTradingMode(env);
    const riskSnapshot = await getRiskSnapshot(env, now);
    const canOpen = await canOpenNewTrade(env, now);
    const openTrades = await getOpenTrades(env);
    const maxOpenPositions = parseInt(
      (await getSetting(env, 'MAX_OPEN_POSITIONS')) || '10'
    );
    
    // Check sync status
    let syncStatus = {
      positions: { success: false, error: null as string | null },
      orders: { success: false, error: null as string | null },
      balances: { success: false, error: null as string | null },
    };
    
    try {
      const positionsSync = await syncPortfolioFromTradier(env);
      syncStatus.positions = {
        success: positionsSync.errors.length === 0,
        error: positionsSync.errors.length > 0 ? positionsSync.errors.join(', ') : null,
      };
    } catch (err) {
      syncStatus.positions = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    
    try {
      const ordersSync = await syncOrdersFromTradier(env);
      syncStatus.orders = {
        success: ordersSync.errors.length === 0,
        error: ordersSync.errors.length > 0 ? ordersSync.errors.join(', ') : null,
      };
    } catch (err) {
      syncStatus.orders = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    
    try {
      const balancesSync = await syncBalancesFromTradier(env);
      syncStatus.balances = {
        success: balancesSync.success,
        error: balancesSync.errors.length > 0 ? balancesSync.errors.join(', ') : null,
      };
    } catch (err) {
      syncStatus.balances = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    
    // Get last proposal run
    const lastProposalRun = await getSetting(env, 'LAST_PROPOSAL_RUN');
    
    // Determine blockers
    const blockers: string[] = [];
    
    if (!tradingDay) {
      blockers.push('NOT_TRADING_DAY');
    }
    if (!marketHours) {
      blockers.push('MARKET_CLOSED');
    }
    if (riskSnapshot.system_mode === 'HARD_STOP') {
      blockers.push('HARD_STOP');
    }
    if (riskSnapshot.risk_state !== 'NORMAL') {
      blockers.push(`RISK_STATE_${riskSnapshot.risk_state}`);
    }
    if (!canOpen) {
      blockers.push('CANNOT_OPEN_NEW_TRADE');
    }
    if (openTrades.length >= maxOpenPositions) {
      blockers.push(`MAX_POSITIONS_REACHED (${openTrades.length}/${maxOpenPositions})`);
    }
    if (!syncStatus.positions.success) {
      blockers.push('POSITIONS_SYNC_FAILED');
    }
    if (!syncStatus.orders.success) {
      blockers.push('ORDERS_SYNC_FAILED');
    }
    if (!syncStatus.balances.success) {
      blockers.push('BALANCES_SYNC_FAILED');
    }
    
    const isBlocked = blockers.length > 0;
    const shouldRun = !isBlocked && marketHours && tradingDay;
    
    return new Response(
      JSON.stringify({
        status: shouldRun ? 'RUNNING' : 'BLOCKED',
        blockers,
        checks: {
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
        sync_status: syncStatus,
        risk_snapshot: {
          daily_realized_pnl: riskSnapshot.daily_realized_pnl,
          emergency_exit_count_today: riskSnapshot.emergency_exit_count_today,
        },
        last_proposal_run: lastProposalRun,
        timestamp: now.toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
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

