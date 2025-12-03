/**
 * Debug endpoint to get today's trading activity recap
 * Queries D1 database for trades, proposals, and system logs from today
 */

import type { Env } from '../env';
import { getTradesToday, getRecentSystemLogs, getOpenTrades, getAllPortfolioPositions } from '../db/queries';
import { getETDateString } from '../core/time';

export async function handleDebugDailyRecap(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const now = new Date();
    const todayET = getETDateString(now);
    
    // Get all trades from today
    const tradesToday = await getTradesToday(env, now);
    
    // Get all open trades
    const openTrades = await getOpenTrades(env);
    
    // Get recent system logs (last 500)
    const recentLogs = await getRecentSystemLogs(env, 500);
    
    // Filter logs from today
    const todayLogs = recentLogs.filter(log => {
      const logDate = new Date(log.created_at);
      return logDate.toISOString().split('T')[0] === todayET;
    });
    
    // Get portfolio positions
    const portfolioPositions = await getAllPortfolioPositions(env);
    
    // Categorize trades
    const tradesOpenedToday = tradesToday.filter(t => {
      const openedDate = t.opened_at ? new Date(t.opened_at).toISOString().split('T')[0] : null;
      return openedDate === todayET;
    });
    
    const tradesClosedToday = tradesToday.filter(t => {
      const closedDate = t.closed_at ? new Date(t.closed_at).toISOString().split('T')[0] : null;
      return closedDate === todayET;
    });
    
    // Count proposals from today
    const proposalLogs = todayLogs.filter(log => 
      log.message?.includes('[proposals]') || log.message?.includes('proposal')
    );
    
    // Count sync events
    const portfolioSyncLogs = todayLogs.filter(log => 
      log.message?.includes('[portfolioSync]')
    );
    
    const orderSyncLogs = todayLogs.filter(log => 
      log.message?.includes('[orderSync]')
    );
    
    const monitorLogs = todayLogs.filter(log => 
      log.message?.includes('[monitor]')
    );
    
    // Find errors
    const errorLogs = todayLogs.filter(log => 
      log.log_type === 'ERROR' || log.message?.toLowerCase().includes('error') || log.message?.toLowerCase().includes('failed')
    );
    
    // Find warnings
    const warningLogs = todayLogs.filter(log => 
      log.log_type === 'WARN' || log.message?.toLowerCase().includes('warn')
    );
    
    return new Response(
      JSON.stringify({
        date: todayET,
        timestamp: now.toISOString(),
        summary: {
          tradesOpenedToday: tradesOpenedToday.length,
          tradesClosedToday: tradesClosedToday.length,
          openPositions: openTrades.length,
          portfolioPositions: portfolioPositions.length,
          totalSystemLogsToday: todayLogs.length,
        },
        trades: {
          opened: tradesOpenedToday.map(t => ({
            id: t.id,
            symbol: t.symbol,
            strategy: t.strategy,
            status: t.status,
            entry_price: t.entry_price,
            opened_at: t.opened_at,
          })),
          closed: tradesClosedToday.map(t => ({
            id: t.id,
            symbol: t.symbol,
            strategy: t.strategy,
            exit_reason: t.exit_reason,
            entry_price: t.entry_price,
            exit_price: t.exit_price,
            realized_pnl: t.realized_pnl,
            closed_at: t.closed_at,
          })),
          open: openTrades.map(t => ({
            id: t.id,
            symbol: t.symbol,
            strategy: t.strategy,
            entry_price: t.entry_price,
            status: t.status,
          })),
        },
        activity: {
          proposalsGenerated: proposalLogs.filter(log => log.message?.includes('scoring_candidates')).length,
          portfolioSyncs: portfolioSyncLogs.filter(log => log.message?.includes('sync complete')).length,
          orderSyncs: orderSyncLogs.filter(log => log.message?.includes('sync complete')).length,
          monitorCycles: monitorLogs.filter(log => log.message?.includes('cycle_start')).length,
        },
        issues: {
          errors: errorLogs.length,
          warnings: warningLogs.length,
          errorLogs: errorLogs.slice(0, 20).map(log => ({
            timestamp: log.created_at,
            message: log.message,
            details: log.details,
          })),
          warningLogs: warningLogs.slice(0, 20).map(log => ({
            timestamp: log.created_at,
            message: log.message,
            details: log.details,
          })),
        },
        recentLogs: todayLogs.slice(0, 100).map(log => ({
          timestamp: log.created_at,
          type: log.log_type,
          message: log.message,
        })),
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
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
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

