/**
 * Debug Broker Events Endpoint
 * 
 * Query broker_events by symbol, order_id, date range, etc.
 * 
 * GET /v2/debug/broker-events?symbol=NVDA&order_id=21976722&limit=100
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import type { BrokerEventRow } from '../types';

interface BrokerEventsResult {
  timestamp: string;
  query: {
    symbol?: string;
    order_id?: string;
    limit?: number;
    dateFrom?: string;
    dateTo?: string;
    operation?: string;
  };
  events: BrokerEventRow[];
  summary: {
    total: number;
    by_operation: Record<string, number>;
    by_ok: { ok: number; error: number };
    errors: Array<{
      created_at: string;
      operation: string;
      error_message: string | null;
      order_id: string | null;
    }>;
  };
}

export async function handleDebugBrokerEvents(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol')?.toUpperCase();
    const orderId = url.searchParams.get('order_id');
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam) : 100;
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    const operation = url.searchParams.get('operation');
    
    const db = getDB(env);
    
    // Build query
    let query = 'SELECT * FROM broker_events WHERE 1=1';
    const params: any[] = [];
    
    if (symbol) {
      query += ' AND symbol = ?';
      params.push(symbol);
    }
    
    if (orderId) {
      query += ' AND order_id = ?';
      params.push(orderId);
    }
    
    if (operation) {
      query += ' AND operation = ?';
      params.push(operation);
    }
    
    if (dateFrom) {
      query += ' AND DATE(created_at) >= ?';
      params.push(dateFrom);
    }
    
    if (dateTo) {
      query += ' AND DATE(created_at) <= ?';
      params.push(dateTo);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    
    const result = await db.prepare(query).bind(...params).all<BrokerEventRow>();
    const events = result.results || [];
    
    // Calculate summary
    const byOperation: Record<string, number> = {};
    let okCount = 0;
    let errorCount = 0;
    const errors: Array<{
      created_at: string;
      operation: string;
      error_message: string | null;
      order_id: string | null;
    }> = [];
    
    for (const event of events) {
      byOperation[event.operation] = (byOperation[event.operation] || 0) + 1;
      // ok is stored as INTEGER (0/1) in DB but typed as boolean in TypeScript
      const isOk = typeof event.ok === 'boolean' ? event.ok : event.ok === 1;
      if (isOk) {
        okCount++;
      } else {
        errorCount++;
        errors.push({
          created_at: event.created_at,
          operation: event.operation,
          error_message: event.error_message,
          order_id: event.order_id || null,
        });
      }
    }
    
    const response: BrokerEventsResult = {
      timestamp: new Date().toISOString(),
      query: {
        symbol: symbol || undefined,
        order_id: orderId || undefined,
        limit,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        operation: operation || undefined,
      },
      events,
      summary: {
        total: events.length,
        by_operation: byOperation,
        by_ok: {
          ok: okCount,
          error: errorCount,
        },
        errors,
      },
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[debugBrokerEvents] error', errorMsg);
    return new Response(JSON.stringify({
      error: errorMsg,
      timestamp: new Date().toISOString(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

