/**
 * Debug endpoint to trace all exit attempts for a specific trade
 * Shows all exit orders, their status, and reasons for failure
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { getTrade } from '../db/queries';
import { getOrdersByTradeId } from '../db/queries_orders';

export async function handleDebugTraceExitAttempts(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tradeId = url.searchParams.get('trade_id');
    const symbol = url.searchParams.get('symbol');
    const shortStrike = url.searchParams.get('short_strike');
    const longStrike = url.searchParams.get('long_strike');
    
    const db = getDB(env);
    let trades: any[] = [];
    
    // Find trades by various criteria
    if (tradeId) {
      const trade = await getTrade(env, tradeId);
      if (trade) trades = [trade];
    } else if (symbol && shortStrike && longStrike) {
      const result = await db.prepare(`
        SELECT * FROM trades 
        WHERE symbol = ? AND short_strike = ? AND long_strike = ?
        ORDER BY created_at DESC
      `).bind(symbol, parseFloat(shortStrike), parseFloat(longStrike)).all();
      trades = result.results || [];
    } else if (symbol) {
      const result = await db.prepare(`
        SELECT * FROM trades 
        WHERE symbol = ?
        ORDER BY created_at DESC
        LIMIT 50
      `).bind(symbol).all();
      trades = result.results || [];
    } else {
      return new Response(
        JSON.stringify({
          error: 'Please provide trade_id or (symbol, short_strike, long_strike)',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    const results = await Promise.all(trades.map(async (trade) => {
      // Get all orders for this trade
      const orders = await getOrdersByTradeId(env, trade.id);
      const exitOrders = orders.filter(o => o.side === 'EXIT');
      
      // Get all orders with this broker_order_id_close
      let closeOrdersByBrokerId: any[] = [];
      if (trade.broker_order_id_close) {
        const { getOrderByTradierOrderId } = await import('../db/queries_orders');
        const closeOrder = await getOrderByTradierOrderId(env, trade.broker_order_id_close);
        if (closeOrder) {
          closeOrdersByBrokerId = [closeOrder];
        }
      }
      
      // Count exit attempts
      const exitAttempts = exitOrders.length;
      const failedExits = exitOrders.filter(o => 
        o.status === 'REJECTED' || 
        o.status === 'CANCELLED' || 
        o.status === 'EXPIRED'
      ).length;
      
      const successfulExits = exitOrders.filter(o => o.status === 'FILLED').length;
      
      return {
        trade: {
          id: trade.id,
          symbol: trade.symbol,
          strategy: trade.strategy,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          quantity: trade.quantity,
          status: trade.status,
          exit_reason: trade.exit_reason,
          entry_price: trade.entry_price,
          exit_price: trade.exit_price,
          broker_order_id_open: trade.broker_order_id_open,
          broker_order_id_close: trade.broker_order_id_close,
          opened_at: trade.opened_at,
          closed_at: trade.closed_at,
          created_at: trade.created_at,
        },
        exit_attempts: {
          total: exitAttempts,
          successful: successfulExits,
          failed: failedExits,
          pending: exitOrders.filter(o => o.status === 'PLACED' || o.status === 'OPEN' || o.status === 'NEW').length,
        },
        exit_orders: exitOrders.map(o => ({
          id: o.id,
          tradier_order_id: o.tradier_order_id,
          status: o.status,
          side: o.side,
          quantity: o.quantity,
          avg_fill_price: o.avg_fill_price,
          created_at: o.created_at,
          updated_at: o.updated_at,
        })),
        close_orders_by_broker_id: closeOrdersByBrokerId.map(o => ({
          id: o.id,
          tradier_order_id: o.tradier_order_id,
          status: o.status,
          side: o.side,
          quantity: o.quantity,
          avg_fill_price: o.avg_fill_price,
          created_at: o.created_at,
          updated_at: o.updated_at,
        })),
      };
    }));
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        search_criteria: {
          trade_id: tradeId,
          symbol,
          short_strike: shortStrike ? parseFloat(shortStrike) : null,
          long_strike: longStrike ? parseFloat(longStrike) : null,
        },
        trades_found: results.length,
        results,
      }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
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

