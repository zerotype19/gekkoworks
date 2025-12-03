/**
 * Daily Activity Summary Endpoint
 * 
 * Generates and retrieves daily trading activity summaries.
 * Summaries are generated automatically at 4:15 PM ET via cron job,
 * and can also be generated on-demand via this endpoint.
 */

import type { Env } from '../env';
import {
  getTradesToday,
  getOpenTrades,
  getAllPortfolioPositions,
  getProposalsByDate,
  insertDailySummary,
  getDailySummary,
  getAllDailySummaries,
  getTradesByStatus,
} from '../db/queries';
import { getETDateString } from '../core/time';
import { TradierClient } from '../broker/tradierClient';

/**
 * Generate a comprehensive daily summary for a specific date
 * Shared function used by both HTTP endpoint and cron job
 */
export async function generateDailySummaryData(env: Env, date: Date): Promise<any> {
  const dateET = getETDateString(date);
  
  // Get all trades from the date
  const tradesToday = await getTradesToday(env, date);
  
  // Get all open trades (as of now)
  const openTrades = await getOpenTrades(env);
  
  // Get portfolio positions
  const portfolioPositions = await getAllPortfolioPositions(env);
  
  // Get proposals generated on this date
  const proposals = await getProposalsByDate(env, dateET);
  
  // Get account snapshot for end-of-day balances
  const broker = new TradierClient(env);
  let balances = null;
  try {
    const { syncBalancesFromTradier } = await import('../engine/balancesSync');
    const balancesResult = await syncBalancesFromTradier(env);
    if (balancesResult.success && balancesResult.balances) {
      balances = balancesResult.balances;
    }
  } catch (error) {
    console.warn('[dailySummary] failed to get balances', error);
  }
  
  // Categorize trades using ET dates
  const { getETDateString: getETDateStr } = await import('../core/time');
  const tradesOpened = tradesToday.filter(t => {
    if (!t.opened_at) return false;
    const openedDateET = getETDateStr(new Date(t.opened_at));
    return openedDateET === dateET;
  });
  
  const tradesClosed = tradesToday.filter(t => {
    if (!t.closed_at) return false;
    const closedDateET = getETDateStr(new Date(t.closed_at));
    return closedDateET === dateET;
  });
  
  // Calculate PnL
  const realizedPnLToday = tradesClosed.reduce((sum, t) => sum + (t.realized_pnl || 0), 0);
  
  // Calculate total unrealized PnL for open positions
  // This is a simplified calculation - in production you might want more detailed PnL tracking
  const openTradesWithPnL = openTrades.filter(t => t.entry_price && t.entry_price > 0);
  
  // Count proposals by status
  const proposalsReady = proposals.filter(p => p.status === 'READY').length;
  const proposalsConsumed = proposals.filter(p => p.status === 'CONSUMED').length;
  const proposalsInvalidated = proposals.filter(p => p.status === 'INVALIDATED').length;
  
  // Count trades by exit reason
  const exitReasons: Record<string, number> = {};
  tradesClosed.forEach(t => {
    const reason = t.exit_reason || 'UNKNOWN';
    exitReasons[reason] = (exitReasons[reason] || 0) + 1;
  });
  
  // Count trades by strategy
  const tradesByStrategy: Record<string, number> = {};
  tradesOpened.forEach(t => {
    const strategy = t.strategy || 'UNKNOWN';
    tradesByStrategy[strategy] = (tradesByStrategy[strategy] || 0) + 1;
  });
  
  // Get open positions count
  const openPositionsCount = portfolioPositions.filter(p => p.quantity > 0).length;
  
  return {
    date: dateET,
    generated_at: new Date().toISOString(),
    summary: {
      trades: {
        opened: tradesOpened.length,
        closed: tradesClosed.length,
        open: openTrades.length,
      },
      proposals: {
        total: proposals.length,
        ready: proposalsReady,
        consumed: proposalsConsumed,
        invalidated: proposalsInvalidated,
      },
      positions: {
        total: portfolioPositions.length,
        open: openPositionsCount,
      },
      pnl: {
        realized_today: realizedPnLToday,
      },
      account: balances ? {
        cash: balances.cash,
        buying_power: balances.buying_power,
        equity: balances.equity,
      } : null,
    },
    details: {
      trades_opened: tradesOpened.map(t => ({
        id: t.id,
        symbol: t.symbol,
        strategy: t.strategy,
        entry_price: t.entry_price,
        opened_at: t.opened_at,
        quantity: t.quantity,
      })),
      trades_closed: tradesClosed.map(t => ({
        id: t.id,
        symbol: t.symbol,
        strategy: t.strategy,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        exit_reason: t.exit_reason,
        realized_pnl: t.realized_pnl,
        closed_at: t.closed_at,
      })),
      open_trades: openTrades.map(t => ({
        id: t.id,
        symbol: t.symbol,
        strategy: t.strategy,
        entry_price: t.entry_price,
        status: t.status,
      })),
      proposals: proposals.map(p => ({
        id: p.id,
        symbol: p.symbol,
        strategy: p.strategy,
        score: p.score,
        status: p.status,
        created_at: p.created_at,
      })),
      exit_reasons: exitReasons,
      trades_by_strategy: tradesByStrategy,
    },
  };
}

/**
 * Handle daily summary endpoint requests
 */
export async function handleDailySummary(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'get';
    const dateParam = url.searchParams.get('date');
    
    if (request.method === 'GET') {
      if (action === 'list') {
        // List all available summaries, filtered to trading days only
        const limit = parseInt(url.searchParams.get('limit') || '30', 10);
        const summaries = await getAllDailySummaries(env, limit);
        
        // Filter to only trading days
        const { isTradingDay } = await import('../core/time');
        const tradingDaySummaries = summaries.filter(s => {
          const date = new Date(s.date + 'T12:00:00Z'); // Use noon UTC to avoid timezone issues
          return isTradingDay(date);
        });
        
        return new Response(
          JSON.stringify({
            summaries: tradingDaySummaries.map(s => ({
              date: s.date,
              generated_at: s.generated_at,
            })),
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      } else {
        // Get specific summary by date
        // If dateParam provided, use it directly (it's already in YYYY-MM-DD format)
        // Otherwise use current date
        const { parseETDateString } = await import('../core/time');
        const dateToQuery = dateParam || getETDateString(new Date());
        const summary = await getDailySummary(env, dateToQuery);
        
        if (!summary) {
          return new Response(
            JSON.stringify({
              error: 'Summary not found',
              date: dateToQuery,
              note: 'Summary will be generated automatically at 4:15 PM ET, or you can generate it on-demand',
            }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        
        // Parse the stored summary data
        const parsedSummary = JSON.parse(summary.summary_data);
        
        return new Response(
          JSON.stringify({
            date: summary.date,
            generated_at: summary.generated_at,
            summary: parsedSummary.summary, // Return the nested summary structure
            details: parsedSummary.details, // Include details as well
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    } else if (request.method === 'POST') {
      // Generate and save summary
      const { parseETDateString } = await import('../core/time');
      const date = dateParam ? parseETDateString(dateParam) : new Date();
      
      // Only generate summaries for trading days
      const { isTradingDay } = await import('../core/time');
      if (!isTradingDay(date)) {
        return new Response(
          JSON.stringify({
            error: 'Summary can only be generated for trading days (Monday-Friday)',
            date: getETDateString(date),
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      
      const summaryData = await generateDailySummaryData(env, date);
      const dateET = getETDateString(date);
      
      await insertDailySummary(env, dateET, summaryData);
      
      // Return same structure as GET endpoint for consistency
      return new Response(
        JSON.stringify({
          date: dateET,
          generated_at: summaryData.generated_at,
          summary: summaryData.summary, // Return the nested summary structure
          details: summaryData.details, // Include details as well
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    return new Response(
      JSON.stringify({ error: 'Invalid request method or action' }),
      {
        status: 400,
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

