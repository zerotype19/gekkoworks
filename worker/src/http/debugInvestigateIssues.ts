/**
 * Debug endpoint to investigate the three issues:
 * 1. Why monitoring didn't trigger exits when in the money
 * 2. Why order sync isn't updating canceled orders
 * 3. Why proposals are being invalidated before entry attempt
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { getOpenTrades } from '../db/queries';
import { getOrdersByTradeId } from '../db/queries_orders';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugInvestigateIssues(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol') || 'AAPL';
    const shortStrike = url.searchParams.get('short_strike');
    const longStrike = url.searchParams.get('long_strike');
    
    const db = getDB(env);
    const broker = new TradierClient(env);
    
    const results: any = {
      timestamp: new Date().toISOString(),
      symbol,
      short_strike: shortStrike ? parseFloat(shortStrike) : null,
      long_strike: longStrike ? parseFloat(longStrike) : null,
    };
    
    // Issue 1: Check monitoring logs for open trades and evaluate them
    const openTrades = await getOpenTrades(env);
    const relevantTrades = openTrades.filter(t => {
      if (t.symbol !== symbol) return false;
      if (shortStrike && t.short_strike !== parseFloat(shortStrike)) return false;
      if (longStrike && t.long_strike !== parseFloat(longStrike)) return false;
      return true;
    });
    
    // Evaluate each trade to see if monitoring would trigger exits
    const monitoringEvaluations = await Promise.all(
      relevantTrades.map(async (trade) => {
        try {
          const { evaluateOpenTrade } = await import('../engine/monitoring');
          const now = new Date();
          const decision = await evaluateOpenTrade(env, trade, now);
          
          return {
            trade_id: trade.id,
            symbol: trade.symbol,
            strategy: trade.strategy,
            entry_price: trade.entry_price,
            opened_at: trade.opened_at,
            quantity: trade.quantity,
            monitoring_decision: {
              trigger: decision.trigger,
              pnl_fraction: decision.metrics.pnl_fraction,
              loss_fraction: decision.metrics.loss_fraction,
              current_mark: decision.metrics.current_mark,
              dte: decision.metrics.dte,
              quote_integrity_ok: decision.metrics.quote_integrity_ok,
            },
            should_exit: decision.trigger !== 'NONE',
          };
        } catch (err) {
          return {
            trade_id: trade.id,
            symbol: trade.symbol,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
    
    results.issue1_monitoring = {
      open_trades_count: relevantTrades.length,
      trades: monitoringEvaluations,
      note: 'Monitoring evaluation results - check if profit targets were reached but exits not triggered',
    };
    
    // Issue 2: Check order sync status for canceled orders
    const allTrades = shortStrike && longStrike
      ? await db.prepare(`
          SELECT * FROM trades 
          WHERE symbol = ? AND short_strike = ? AND long_strike = ?
          ORDER BY created_at DESC
          LIMIT 10
        `).bind(symbol, parseFloat(shortStrike), parseFloat(longStrike)).all()
      : await db.prepare(`
          SELECT * FROM trades 
          WHERE symbol = ?
          ORDER BY created_at DESC
          LIMIT 10
        `).bind(symbol).all();
    
    const tradesWithOrders = await Promise.all(
      (allTrades.results || []).map(async (trade: any) => {
        const orders = await getOrdersByTradeId(env, trade.id);
        const exitOrders = orders.filter(o => o.side === 'EXIT');
        
        // Check Tradier directly for these orders
        const tradierStatuses: any[] = [];
        for (const order of exitOrders) {
          if (order.tradier_order_id) {
            try {
              const tradierOrder = await broker.getOrder(order.tradier_order_id);
              // Map Tradier status to our OrderStatus format
              const tradierStatusLower = tradierOrder.status.toLowerCase();
              let mappedTradierStatus: string;
              if (tradierStatusLower === 'filled') {
                mappedTradierStatus = 'FILLED';
              } else if (tradierStatusLower === 'cancelled' || tradierStatusLower === 'canceled') {
                mappedTradierStatus = 'CANCELLED';
              } else if (tradierStatusLower === 'rejected') {
                mappedTradierStatus = 'REJECTED';
              } else if (tradierStatusLower === 'open' || tradierStatusLower === 'pending') {
                mappedTradierStatus = 'PLACED';
              } else {
                mappedTradierStatus = tradierOrder.status;
              }
              
              tradierStatuses.push({
                local_order_id: order.id,
                tradier_order_id: order.tradier_order_id,
                local_status: order.status,
                tradier_status: tradierOrder.status,
                mapped_tradier_status: mappedTradierStatus,
                match: order.status === mappedTradierStatus,
                needs_sync: order.status !== mappedTradierStatus,
              });
            } catch (err) {
              tradierStatuses.push({
                local_order_id: order.id,
                tradier_order_id: order.tradier_order_id,
                local_status: order.status,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        
        return {
          trade_id: trade.id,
          status: trade.status,
          broker_order_id_close: trade.broker_order_id_close,
          exit_orders: exitOrders.map(o => ({
            id: o.id,
            tradier_order_id: o.tradier_order_id,
            status: o.status,
            created_at: o.created_at,
            updated_at: o.updated_at,
          })),
          tradier_status_check: tradierStatuses,
        };
      })
    );
    
    results.issue2_order_sync = {
      trades_checked: tradesWithOrders.length,
      trades: tradesWithOrders,
      note: 'Compare local order status vs Tradier status - should match',
    };
    
    // Issue 3: Check recent invalidated proposals
    const invalidatedProposals = await db.prepare(`
      SELECT * FROM proposals 
      WHERE status = 'INVALIDATED' 
      AND symbol = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).bind(symbol).all();
    
    // Get reasons from system_logs if available
    const proposalReasons: any[] = [];
    for (const proposal of (invalidatedProposals.results || [])) {
      // Look for invalidation logs - check for both proposal ID and invalidation message
      const logs = await db.prepare(`
        SELECT * FROM system_logs 
        WHERE (message LIKE ? OR message LIKE ?)
        AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 10
      `).bind(`%${proposal.id}%`, `%[entry][proposal][invalidated]%`, proposal.created_at).all();
      
      proposalReasons.push({
        proposal_id: proposal.id,
        created_at: proposal.created_at,
        invalidated_at: proposal.updated_at,
        strategy: proposal.strategy,
        score: proposal.score,
        logs: (logs.results || []).map((l: any) => ({
          message: l.message,
          created_at: l.created_at,
        })),
      });
    }
    
    results.issue3_proposal_invalidation = {
      invalidated_count: invalidatedProposals.results?.length || 0,
      proposals: proposalReasons,
      note: 'Check logs for reasons why proposals were invalidated',
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

