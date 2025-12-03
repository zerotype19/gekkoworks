/**
 * Detailed analysis endpoint that queries D1 database directly
 * Analyzes all trades, proposals, orders, and portfolio positions
 * Provides comprehensive breakdown to understand discrepancies
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { getETDateString } from '../core/time';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugAnalyzeTradesDetailed(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const dateParam = url.searchParams.get('date');
    // If date param provided, parse it as ET date string (YYYY-MM-DD) to avoid timezone issues
    // Otherwise use current date
    const { parseETDateString, getETDateString } = await import('../core/time');
    const date = dateParam ? parseETDateString(dateParam) : new Date();
    const dateET = dateParam || getETDateString(date);
    
    const db = getDB(env);
    const broker = new TradierClient(env);
    
    // Query D1 directly for all data
    const tradesResult = await db.prepare(`
      SELECT * FROM trades 
      ORDER BY created_at DESC
      LIMIT 500
    `).all();
    
    const proposalsResult = await db.prepare(`
      SELECT * FROM proposals 
      ORDER BY created_at DESC
      LIMIT 500
    `).all();
    
    // Get broker events and system logs for context
    const brokerEventsResult = await db.prepare(`
      SELECT * FROM broker_events 
      WHERE created_at LIKE ? || '%'
      ORDER BY created_at DESC
      LIMIT 200
    `).bind(dateET).all();
    
    const systemLogsResult = await db.prepare(`
      SELECT * FROM system_logs 
      WHERE created_at LIKE ? || '%'
      ORDER BY created_at DESC
      LIMIT 200
    `).bind(dateET).all();
    
    // Filter trades by ET date properly
    const { getETDateString: getETDateStr } = await import('../core/time');
    const allTrades = (tradesResult.results || []) as any[];
    
    const tradesOpenedToday = allTrades.filter(t => {
      if (!t.opened_at) return false;
      const openedET = getETDateStr(new Date(t.opened_at));
      return openedET === dateET;
    });
    
    const tradesClosedToday = allTrades.filter(t => {
      if (!t.closed_at) return false;
      const closedET = getETDateStr(new Date(t.closed_at));
      return closedET === dateET;
    });
    
    // Detailed breakdown of closed trades
    const closedTradesBreakdown = tradesClosedToday.map((t: any) => {
      return {
        trade_id: t.id,
        symbol: t.symbol,
        strategy: t.strategy,
        status: t.status,
        broker_order_id_open: t.broker_order_id_open,
        broker_order_id_close: t.broker_order_id_close,
        opened_at: t.opened_at,
        opened_at_et: t.opened_at ? getETDateStr(new Date(t.opened_at)) : null,
        closed_at: t.closed_at,
        closed_at_et: t.closed_at ? getETDateStr(new Date(t.closed_at)) : null,
        exit_price: t.exit_price,
        realized_pnl: t.realized_pnl,
        exit_reason: t.exit_reason,
        has_exit_price: t.exit_price !== null && t.exit_price !== undefined,
        has_pnl: t.realized_pnl !== null && t.realized_pnl !== undefined,
      };
    });
    
    // Get Tradier data for comparison
    const startDate = new Date(date);
    startDate.setDate(startDate.getDate() - 1);
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);
    
    let tradierOrders: any[] = [];
    let tradierClosedPositions: any[] = [];
    
    try {
      const orders = await broker.getAllOrders(
        'all',
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0]
      );
      tradierOrders = orders;
    } catch (error) {
      console.error('[debugAnalyzeDetailed] failed to get Tradier orders', error);
    }
    
    try {
      const gainLossData = await broker.getGainLoss({
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      });
      tradierClosedPositions = gainLossData;
    } catch (error) {
      console.error('[debugAnalyzeDetailed] failed to get Tradier gain/loss', error);
    }
    
    // Match close orders to Tradier
    const closeOrderAnalysis = tradesClosedToday.map((t: any) => {
      if (!t.broker_order_id_close) {
        return {
          trade_id: t.id,
          symbol: t.symbol,
          status: 'NO_CLOSE_ORDER_ID',
          note: 'Trade marked CLOSED but no broker_order_id_close',
        };
      }
      
      const matchingOrder = tradierOrders.find(o => o.id === t.broker_order_id_close);
      if (!matchingOrder) {
        return {
          trade_id: t.id,
          symbol: t.symbol,
          broker_order_id_close: t.broker_order_id_close,
          status: 'ORDER_NOT_FOUND_IN_TRADIER',
          note: 'Close order ID exists but not found in Tradier orders',
        };
      }
      
      return {
        trade_id: t.id,
        symbol: t.symbol,
        broker_order_id_close: t.broker_order_id_close,
        order_status: matchingOrder.status,
        order_created_at: matchingOrder.created_at,
        order_status_filled: matchingOrder.status === 'FILLED',
        note: matchingOrder.status === 'FILLED' 
          ? 'Valid close - order filled' 
          : `Invalid close - order ${matchingOrder.status.toLowerCase()}`,
      };
    });
    
    return new Response(
      JSON.stringify({
        date: dateET,
        analysis: {
          our_database: {
            total_trades: allTrades.length,
            trades_opened_today: tradesOpenedToday.length,
            trades_closed_today: tradesClosedToday.length,
            closed_trades_breakdown: closedTradesBreakdown,
            close_order_analysis: closeOrderAnalysis,
          },
          tradier_comparison: {
            total_orders_in_range: tradierOrders.length,
            closed_positions_in_range: tradierClosedPositions.length,
          },
        },
        key_findings: {
          date_filtering_issues: closedTradesBreakdown.filter((t: any) => {
            // Check if closed_at_et doesn't match dateET
            return t.closed_at_et !== dateET;
          }).length,
          missing_exit_data: closedTradesBreakdown.filter((t: any) => {
            return !t.has_exit_price || !t.has_pnl;
          }).length,
          invalid_close_orders: closeOrderAnalysis.filter((c: any) => {
            return c.status !== 'Valid close - order filled';
          }).length,
        },
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

