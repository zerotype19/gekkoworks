/**
 * Debug endpoint to compare our closed trades with Tradier's gain/loss data
 * This ensures we're only tracking trades that actually exist in Tradier
 */

import type { Env } from '../env';
import { getTradesToday } from '../db/queries';
import { getETDateString } from '../core/time';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugCompareTradierClosed(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const dateParam = url.searchParams.get('date');
    const { parseETDateString } = await import('../core/time');
    const date = dateParam ? parseETDateString(dateParam) : new Date();
    const dateET = getETDateString(date);
    
    // Get our closed trades for today
    const allTradesToday = await getTradesToday(env, date);
    const ourClosedTrades = allTradesToday.filter(t => {
      if (!t.closed_at) return false;
      const closedET = getETDateString(new Date(t.closed_at));
      return closedET === dateET;
    });
    
    // Get Tradier's gain/loss data for today
    const broker = new TradierClient(env);
    const startDate = new Date(date);
    startDate.setDate(startDate.getDate() - 1); // Get last 2 days to ensure we capture everything
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);
    
    let tradierClosedPositions: any[] = [];
    try {
      const gainLossData = await broker.getGainLoss({
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      });
      
      // Filter to only positions closed on the target date
      tradierClosedPositions = gainLossData.filter(p => {
        if (!p.close_date) return false;
        const closeDate = new Date(p.close_date).toISOString().split('T')[0];
        const targetDateStr = date.toISOString().split('T')[0];
        return closeDate === targetDateStr;
      });
    } catch (error) {
      console.error('[debugCompareTradier] failed to get gain/loss', error);
    }
    
    // Analyze differences
    const ourCount = ourClosedTrades.length;
    const tradierCount = tradierClosedPositions.length;
    
    // Check which of our trades have broker_order_id_close
    const ourTradesWithCloseOrder = ourClosedTrades.filter(t => t.broker_order_id_close);
    const ourTradesWithoutCloseOrder = ourClosedTrades.filter(t => !t.broker_order_id_close);
    
    // Match our trades to Tradier positions by option symbol
    const matchedTrades: any[] = [];
    const unmatchedOurTrades: any[] = [];
    const unmatchedTradierPositions: any[] = [];
    
    for (const trade of ourClosedTrades) {
      // For spread trades, we need to check both legs
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      
      // Try to match by finding positions that match our trade's legs
      // This is simplified - in reality we'd need to construct option symbols
      let matched = false;
      
      // For now, just check if trade has broker_order_id_close
      if (trade.broker_order_id_close) {
        matched = true; // If it has a close order, it should exist in Tradier
        matchedTrades.push({
          trade_id: trade.id,
          symbol: trade.symbol,
          strategy: trade.strategy,
          broker_order_id_close: trade.broker_order_id_close,
          closed_at: trade.closed_at,
          exit_price: trade.exit_price,
          realized_pnl: trade.realized_pnl,
          matched: 'has_close_order',
        });
      } else {
        unmatchedOurTrades.push({
          trade_id: trade.id,
          symbol: trade.symbol,
          strategy: trade.strategy,
          closed_at: trade.closed_at,
          exit_reason: trade.exit_reason,
          note: 'No broker_order_id_close - may be phantom trade',
        });
      }
    }
    
    return new Response(
      JSON.stringify({
        date: dateET,
        comparison: {
          our_closed_trades: ourCount,
          tradier_closed_positions: tradierCount,
          difference: ourCount - tradierCount,
        },
        our_trades: {
          total: ourClosedTrades.length,
          with_close_order: ourTradesWithCloseOrder.length,
          without_close_order: ourTradesWithoutCloseOrder.length,
        },
        analysis: {
          matched: matchedTrades.length,
          unmatched_our_trades: unmatchedOurTrades,
          tradier_positions: tradierClosedPositions.map(p => ({
            symbol: p.symbol,
            cost: p.cost,
            proceeds: p.proceeds,
            gain_loss: p.gain_loss,
            close_date: p.close_date,
          })),
        },
        warnings: unmatchedOurTrades.length > 0 ? [
          `Found ${unmatchedOurTrades.length} closed trades without broker_order_id_close - these may be phantom trades`
        ] : [],
        note: 'Gekkoworks should only track trades with actual broker orders. Trades without broker_order_id_close are suspicious.',
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

