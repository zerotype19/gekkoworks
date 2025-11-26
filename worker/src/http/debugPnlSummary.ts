/**
 * Debug PnL Summary Endpoint
 * 
 * Comprehensive PnL reporting with:
 * - Realized PnL by day (last N days)
 * - Realized PnL by underlying and strategy
 * - Open risk (sum(max_loss)) by underlying
 * - Exit counts by reason
 */

import type { Env } from '../env';
import { getAllTrades, getOpenTrades } from '../db/queries';

export async function handleDebugPnlSummary(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const daysParam = url.searchParams.get('days');
    const days = daysParam ? parseInt(daysParam, 10) : 7; // Default to 7 days
    
    const now = new Date();
    const trades = await getAllTrades(env, 10000); // Get many trades for analysis
    
    // Calculate date range
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - days);
    
    // Filter trades in date range
    const tradesInRange = trades.filter(t => {
      if (!t.closed_at) return false;
      const closedDate = new Date(t.closed_at);
      return closedDate >= startDate;
    });
    
    // 1. Realized PnL by day
    const pnlByDay: Record<string, number> = {};
    for (const trade of tradesInRange) {
      if (trade.status === 'CLOSED' && trade.realized_pnl !== null && trade.closed_at) {
        const day = trade.closed_at.split('T')[0];
        pnlByDay[day] = (pnlByDay[day] || 0) + trade.realized_pnl;
      }
    }
    
    // Convert to sorted array
    const pnlByDayArray = Object.entries(pnlByDay)
      .map(([date, pnl]) => ({ date, realized_pnl: pnl }))
      .sort((a, b) => a.date.localeCompare(b.date));
    
    // 2. Realized PnL by underlying and strategy
    const pnlByUnderlyingStrategy: Record<string, Record<string, number>> = {};
    for (const trade of tradesInRange) {
      if (trade.status === 'CLOSED' && trade.realized_pnl !== null) {
        const symbol = trade.symbol;
        const strategy = trade.strategy || 'UNKNOWN';
        
        if (!pnlByUnderlyingStrategy[symbol]) {
          pnlByUnderlyingStrategy[symbol] = {};
        }
        if (!pnlByUnderlyingStrategy[symbol][strategy]) {
          pnlByUnderlyingStrategy[symbol][strategy] = 0;
        }
        pnlByUnderlyingStrategy[symbol][strategy] += trade.realized_pnl;
      }
    }
    
    // Convert to array format
    const pnlByUnderlyingStrategyArray = Object.entries(pnlByUnderlyingStrategy).map(
      ([symbol, strategies]) => ({
        symbol,
        by_strategy: Object.entries(strategies).map(([strategy, pnl]) => ({
          strategy,
          realized_pnl: pnl,
        })),
        total: Object.values(strategies).reduce((sum, pnl) => sum + pnl, 0),
      })
    );
    
    // 3. Open risk (sum(max_loss)) by underlying
    const openTrades = await getOpenTrades(env);
    const openRiskByUnderlying: Record<string, number> = {};
    for (const trade of openTrades) {
      if (trade.status === 'OPEN' && trade.max_loss !== null) {
        const symbol = trade.symbol;
        openRiskByUnderlying[symbol] = (openRiskByUnderlying[symbol] || 0) + trade.max_loss;
      }
    }
    
    const openRiskByUnderlyingArray = Object.entries(openRiskByUnderlying)
      .map(([symbol, risk]) => ({ symbol, open_risk: risk }))
      .sort((a, b) => b.open_risk - a.open_risk);
    
    // Total open risk
    const totalOpenRisk = Object.values(openRiskByUnderlying).reduce((sum, risk) => sum + risk, 0);
    
    // 4. Exit counts by reason
    const exitCountsByReason: Record<string, number> = {};
    for (const trade of tradesInRange) {
      if (trade.status === 'CLOSED' && trade.exit_reason) {
        const reason = trade.exit_reason;
        exitCountsByReason[reason] = (exitCountsByReason[reason] || 0) + 1;
      }
    }
    
    // Also count by exit trigger type (PROFIT_TARGET, STOP_LOSS, TIME_EXIT, etc.)
    // Map exit_reason to common categories
    const exitCategoryMap: Record<string, string> = {
      'PROFIT_TARGET': 'PROFIT_TARGET',
      'STOP_LOSS': 'STOP_LOSS',
      'TIME_EXIT': 'TIME_EXIT',
      'TRAIL_PROFIT': 'TRAIL_PROFIT',
      'IV_CRUSH_EXIT': 'IV_CRUSH_EXIT',
      'EMERGENCY': 'EMERGENCY',
      'MANUAL': 'MANUAL',
    };
    
    const exitCountsByCategory: Record<string, number> = {};
    for (const trade of tradesInRange) {
      if (trade.status === 'CLOSED' && trade.exit_reason) {
        const category = exitCategoryMap[trade.exit_reason] || 'OTHER';
        exitCountsByCategory[category] = (exitCountsByCategory[category] || 0) + 1;
      }
    }
    
    // 5. Summary statistics
    const closedTrades = tradesInRange.filter(t => t.status === 'CLOSED');
    const totalRealizedPnL = closedTrades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0);
    const winningTrades = closedTrades.filter(t => (t.realized_pnl || 0) > 0).length;
    const losingTrades = closedTrades.filter(t => (t.realized_pnl || 0) < 0).length;
    const avgWin = winningTrades > 0
      ? closedTrades.filter(t => (t.realized_pnl || 0) > 0).reduce((sum, t) => sum + (t.realized_pnl || 0), 0) / winningTrades
      : 0;
    const avgLoss = losingTrades > 0
      ? closedTrades.filter(t => (t.realized_pnl || 0) < 0).reduce((sum, t) => sum + (t.realized_pnl || 0), 0) / losingTrades
      : 0;
    
    const body = {
      period: {
        start_date: startDate.toISOString().split('T')[0],
        end_date: now.toISOString().split('T')[0],
        days,
      },
      realized_pnl_by_day: pnlByDayArray,
      realized_pnl_by_underlying_strategy: pnlByUnderlyingStrategyArray,
      open_risk: {
        total: totalOpenRisk,
        by_underlying: openRiskByUnderlyingArray,
      },
      exit_counts: {
        by_reason: exitCountsByReason,
        by_category: exitCountsByCategory,
      },
      summary: {
        total_realized_pnl: totalRealizedPnL,
        total_closed_trades: closedTrades.length,
        winning_trades: winningTrades,
        losing_trades: losingTrades,
        win_rate: closedTrades.length > 0 ? (winningTrades / closedTrades.length) : 0,
        avg_win: avgWin,
        avg_loss: avgLoss,
        profit_factor: avgLoss !== 0 ? Math.abs(avgWin * winningTrades / (avgLoss * losingTrades)) : (winningTrades > 0 ? Infinity : 0),
      },
      meta: {
        generated_at: now.toISOString(),
        trades_analyzed: tradesInRange.length,
        open_trades_count: openTrades.length,
      },
    };
    
    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify(
        {
          error: error?.message ?? String(error),
        },
        null,
        2
      ),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

