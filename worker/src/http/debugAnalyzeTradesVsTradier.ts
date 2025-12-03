/**
 * Comprehensive analysis endpoint to compare D1 database state with Tradier
 * Analyzes trades, orders, proposals, and portfolio positions to find discrepancies
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { getETDateString } from '../core/time';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugAnalyzeTradesVsTradier(
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
    
    // 1. Get all trades from D1 - query ALL trades and filter in application layer
    const tradesResult = await db.prepare(`
      SELECT * FROM trades 
      WHERE opened_at IS NOT NULL OR closed_at IS NOT NULL OR created_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 500
    `).all();
    
    const allTrades = tradesResult.results || [];
    
    // Filter by ET date properly
    const { getETDateString: getETDateStr } = await import('../core/time');
    const tradesOpenedToday = allTrades.filter((t: any) => {
      if (!t.opened_at) return false;
      const openedET = getETDateStr(new Date(t.opened_at));
      return openedET === dateET;
    });
    
    const tradesClosedToday = allTrades.filter((t: any) => {
      if (!t.closed_at) return false;
      const closedET = getETDateStr(new Date(t.closed_at));
      return closedET === dateET;
    });
    
    // 2. Get Tradier orders for today
    const startDate = new Date(date);
    startDate.setDate(startDate.getDate() - 1);
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);
    
    let tradierOrders: any[] = [];
    try {
      const orders = await broker.getAllOrders(
        'all',
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0]
      );
      tradierOrders = orders.filter(o => {
        if (!o.created_at) return false;
        const orderDate = new Date(o.created_at).toISOString().split('T')[0];
        const targetDateStr = date.toISOString().split('T')[0];
        return orderDate === targetDateStr;
      });
    } catch (error) {
      console.error('[debugAnalyze] failed to get Tradier orders', error);
    }
    
    // 3. Get Tradier gain/loss for today
    let tradierClosedPositions: any[] = [];
    try {
      const gainLossData = await broker.getGainLoss({
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      });
      tradierClosedPositions = gainLossData.filter(p => {
        if (!p.close_date) return false;
        const closeDate = new Date(p.close_date).toISOString().split('T')[0];
        const targetDateStr = date.toISOString().split('T')[0];
        return closeDate === targetDateStr;
      });
    } catch (error) {
      console.error('[debugAnalyze] failed to get Tradier gain/loss', error);
    }
    
    // 4. Get detailed order info for filled orders only (to identify entry vs exit)
    const tradierFilledOrders = tradierOrders.filter(o => o.status === 'FILLED');
    const tradierOrdersWithDetails: any[] = [];
    
    for (const order of tradierFilledOrders.slice(0, 50)) { // Limit to avoid timeouts
      try {
        const orderDetails = await broker.getOrderWithLegs(order.id);
        tradierOrdersWithDetails.push(orderDetails);
      } catch (error) {
        // Fallback to basic order if details fail
        tradierOrdersWithDetails.push({
          ...order,
          leg: [],
        });
      }
    }
    
    // 5. Analyze entry orders (FILLED = trade opened)
    // Entry orders have buy_to_open/sell_to_open
    const tradierFilledEntryOrders = tradierOrdersWithDetails.filter(o => {
      const legs = o.leg || [];
      return legs.some((leg: any) => 
        leg.side?.includes('buy_to_open') || leg.side?.includes('sell_to_open')
      );
    });
    
    // 6. Analyze exit orders (FILLED = trade closed)
    // Exit orders have buy_to_close/sell_to_close
    const tradierFilledExitOrders = tradierOrdersWithDetails.filter(o => {
      const legs = o.leg || [];
      return legs.some((leg: any) => 
        leg.side?.includes('buy_to_close') || leg.side?.includes('sell_to_close')
      );
    });
    
    // 7. Detailed analysis of closed trades
    const closedTradesAnalysis = tradesClosedToday.map((t: any) => {
      // Find matching Tradier exit order
      let tradierOrder = null;
      if (t.broker_order_id_close) {
        tradierOrder = tradierOrdersWithDetails.find(o => o.id === t.broker_order_id_close);
      }
      
      return {
        trade_id: t.id,
        symbol: t.symbol,
        strategy: t.strategy,
        status: t.status,
        broker_order_id_open: t.broker_order_id_open,
        broker_order_id_close: t.broker_order_id_close,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
        exit_price: t.exit_price,
        realized_pnl: t.realized_pnl,
        exit_reason: t.exit_reason,
        tradier_order_status: tradierOrder?.status || (t.broker_order_id_close ? 'NOT_FOUND' : 'NO_ORDER_ID'),
        tradier_order_filled: tradierOrder?.status === 'FILLED',
        is_phantom_close: !t.broker_order_id_close || !tradierOrder || tradierOrder.status !== 'FILLED',
      };
    });
    
    const phantomCloses = closedTradesAnalysis.filter(t => t.is_phantom_close);
    const validCloses = closedTradesAnalysis.filter(t => !t.is_phantom_close);
    
    // 7. Count unique parent orders for spreads
    const uniqueEntrySpreads = new Set(
      tradierFilledEntryOrders
        .filter(o => o.leg && o.leg.length === 2)
        .map(o => o.id)
    );
    
    const uniqueExitSpreads = new Set(
      tradierFilledExitOrders
        .filter(o => o.leg && o.leg.length === 2)
        .map(o => o.id)
    );
    
    return new Response(
      JSON.stringify({
        date: dateET,
        summary: {
          our_trades: {
            total: allTrades.length,
            opened_today: tradesOpenedToday.length,
            closed_today: tradesClosedToday.length,
          },
          tradier: {
            total_orders: tradierOrders.length,
            filled_entry_orders: tradierFilledEntryOrders.length,
            filled_exit_orders: tradierFilledExitOrders.length,
            unique_entry_spreads: uniqueEntrySpreads.size,
            unique_exit_spreads: uniqueExitSpreads.size,
            closed_positions: tradierClosedPositions.length,
          },
          discrepancies: {
            trades_opened_vs_entry_orders: tradesOpenedToday.length - uniqueEntrySpreads.size,
            trades_closed_vs_exit_orders: tradesClosedToday.length - uniqueExitSpreads.size,
            trades_closed_vs_positions: tradesClosedToday.length - tradierClosedPositions.length / 2, // Each spread = 2 positions
          },
        },
        our_trades_closed_today: tradesClosedToday.map((t: any) => ({
          id: t.id,
          symbol: t.symbol,
          strategy: t.strategy,
          broker_order_id_open: t.broker_order_id_open,
          broker_order_id_close: t.broker_order_id_close,
          opened_at: t.opened_at,
          closed_at: t.closed_at,
          exit_price: t.exit_price,
          realized_pnl: t.realized_pnl,
          exit_reason: t.exit_reason,
          status: t.status,
        })),
        tradier_filled_exit_orders: tradierFilledExitOrders.map(o => ({
          id: o.id,
          status: o.status,
          created_at: o.created_at,
          avg_fill_price: o.avg_fill_price,
          legs: o.leg?.map((l: any) => ({
            symbol: l.option_symbol,
            side: l.side,
            quantity: l.quantity,
            price: l.price,
          })),
        })),
        tradier_closed_positions: tradierClosedPositions.map(p => ({
          symbol: p.symbol,
          cost: p.cost,
          proceeds: p.proceeds,
          gain_loss: p.gain_loss,
          close_date: p.close_date,
        })),
        analysis: {
          valid_closes: validCloses.length,
          phantom_closes: phantomCloses.length,
          valid_closes_detail: validCloses,
          phantom_closes_detail: phantomCloses,
        },
        warnings: [
          ...(phantomCloses.length > 0 ? [
            `Found ${phantomCloses.length} phantom closes - trades marked CLOSED but no matching Tradier filled exit order`
          ] : []),
          ...(tradesClosedToday.length > uniqueExitSpreads.size ? [
            `Tracking ${tradesClosedToday.length} closed trades but Tradier shows only ${uniqueExitSpreads.size} filled exit orders`
          ] : []),
          ...(tradesClosedToday.length > 0 && tradesClosedToday.filter((t: any) => !t.exit_price || !t.realized_pnl).length > 0 ? [
            `Found ${tradesClosedToday.filter((t: any) => !t.exit_price || !t.realized_pnl).length} closed trades missing exit_price or realized_pnl - backfill needed`
          ] : []),
        ],
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

