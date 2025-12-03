/**
 * Debug Trade History Endpoint
 * 
 * Query trades by symbol, status, date range, etc. to investigate trade history.
 * 
 * GET /v2/debug/trade-history?symbol=NVDA&status=CLOSED&limit=100
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import type { TradeRow } from '../types';

interface TradeHistoryResult {
  timestamp: string;
  query: {
    symbol?: string;
    status?: string;
    limit?: number;
    dateFrom?: string;
    dateTo?: string;
  };
  trades: Array<{
    trade_id: string;
    proposal_id: string | null;
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    quantity: number;
    strategy: string | null;
    entry_price: number | null;
    exit_price: number | null;
    realized_pnl: number | null;
    status: string;
    exit_reason: string | null;
    broker_order_id_open: string | null;
    broker_order_id_close: string | null;
    opened_at: string | null;
    closed_at: string | null;
    created_at: string;
  }>;
  summary: {
    total: number;
    by_status: Record<string, number>;
    by_exit_reason: Record<string, number>;
    total_realized_pnl: number;
  };
}

export async function handleDebugTradeHistory(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol')?.toUpperCase();
    const status = url.searchParams.get('status');
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam) : 100;
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    
    const db = getDB(env);
    
    // Build query
    let query = 'SELECT * FROM trades WHERE 1=1';
    const params: any[] = [];
    
    if (symbol) {
      query += ' AND symbol = ?';
      params.push(symbol);
    }
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    if (dateFrom) {
      query += ' AND DATE(closed_at) >= ?';
      params.push(dateFrom);
    }
    
    if (dateTo) {
      query += ' AND DATE(closed_at) <= ?';
      params.push(dateTo);
    }
    
    query += ' ORDER BY closed_at DESC, created_at DESC LIMIT ?';
    params.push(limit);
    
    const result = await db.prepare(query).bind(...params).all<TradeRow>();
    const trades = result.results || [];
    
    // Calculate summary
    const byStatus: Record<string, number> = {};
    const byExitReason: Record<string, number> = {};
    let totalRealizedPnl = 0;
    
    for (const trade of trades) {
      byStatus[trade.status] = (byStatus[trade.status] || 0) + 1;
      if (trade.exit_reason) {
        byExitReason[trade.exit_reason] = (byExitReason[trade.exit_reason] || 0) + 1;
      }
      if (trade.realized_pnl !== null) {
        totalRealizedPnl += trade.realized_pnl;
      }
    }
    
    const response: TradeHistoryResult = {
      timestamp: new Date().toISOString(),
      query: {
        symbol: symbol || undefined,
        status: status || undefined,
        limit,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      },
      trades: trades.map(t => ({
        trade_id: t.id,
        proposal_id: t.proposal_id,
        symbol: t.symbol,
        expiration: t.expiration,
        short_strike: t.short_strike,
        long_strike: t.long_strike,
        quantity: t.quantity,
        strategy: t.strategy || null,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        realized_pnl: t.realized_pnl,
        status: t.status,
        exit_reason: t.exit_reason,
        broker_order_id_open: t.broker_order_id_open,
        broker_order_id_close: t.broker_order_id_close,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
        created_at: t.created_at,
      })),
      summary: {
        total: trades.length,
        by_status: byStatus,
        by_exit_reason: byExitReason,
        total_realized_pnl: totalRealizedPnl,
      },
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[debugTradeHistory] error', errorMsg);
    return new Response(JSON.stringify({
      error: errorMsg,
      timestamp: new Date().toISOString(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

