/**
 * Debug endpoint to inspect latest Tradier snapshot
 * 
 * GET /debug/tradier/snapshot
 * Optional query: ?accountId=...
 * 
 * Returns the latest snapshot from D1 or triggers a new sync.
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { syncTradierSnapshot } from '../tradier/syncTradierSnapshot';
import { getAllPortfolioPositions } from '../db/queries';
import { getRecentOrders } from '../db/queries_orders';

export async function handleDebugTradierSnapshot(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const accountId = url.searchParams.get('accountId') || undefined;
    const triggerSync = url.searchParams.get('sync') === 'true';
    
    if (triggerSync) {
      // Trigger a new sync and return the result
      const result = await syncTradierSnapshot(env, accountId);
      
      return new Response(
        JSON.stringify({
          triggered: true,
          success: result.success,
          snapshot: result.snapshot,
          errors: result.errors,
          warnings: result.warnings,
        }),
        {
          status: result.success ? 200 : 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Return latest snapshot from D1
    const db = getDB(env);
    
    // Get latest snapshot
    const latestSnapshot = await db.prepare(`
      SELECT * FROM tradier_snapshots
      ORDER BY as_of DESC
      LIMIT 1
    `).first<{
      id: string;
      account_id: string;
      as_of: string;
      positions_count: number;
      orders_count: number;
      balances_cash: number | null;
      balances_buying_power: number | null;
      balances_equity: number | null;
      balances_margin_requirement: number | null;
      created_at: string;
    }>();
    
    if (!latestSnapshot) {
      return new Response(
        JSON.stringify({
          error: 'No snapshots found - trigger a sync first with ?sync=true',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Get latest balances for this snapshot
    const latestBalances = latestSnapshot ? await db.prepare(`
      SELECT * FROM account_balances
      WHERE snapshot_id = ?
      ORDER BY as_of DESC
      LIMIT 1
    `).bind(latestSnapshot.id).first<{
      id: string;
      account_id: string;
      snapshot_id: string;
      cash: number;
      buying_power: number;
      equity: number;
      margin_requirement: number;
      as_of: string;
      created_at: string;
    }>() : null;
    
    // Get positions with this snapshot_id
    const positions = await getAllPortfolioPositions(env);
    const positionsInSnapshot = positions.filter(p => p.snapshot_id === latestSnapshot.id);
    
    // Get orders with this snapshot_id
    const orders = await getRecentOrders(env, 1000);
    const ordersInSnapshot = orders.filter(o => o.snapshot_id === latestSnapshot.id);
    
    return new Response(
      JSON.stringify({
        snapshot: {
          snapshotId: latestSnapshot.id,
          asOf: latestSnapshot.as_of,
          accountId: latestSnapshot.account_id,
          balances: latestBalances ? {
            cash: latestBalances.cash,
            buying_power: latestBalances.buying_power,
            equity: latestBalances.equity,
            margin_requirement: latestBalances.margin_requirement,
          } : null,
          counts: {
            positions: latestSnapshot.positions_count,
            orders: latestSnapshot.orders_count,
            positions_in_db: positionsInSnapshot.length,
            orders_in_db: ordersInSnapshot.length,
          },
          positions_sample: positionsInSnapshot.slice(0, 10).map(p => ({
            symbol: p.symbol,
            expiration: p.expiration,
            option_type: p.option_type,
            strike: p.strike,
            side: p.side,
            quantity: p.quantity,
          })),
          orders_sample: ordersInSnapshot.slice(0, 10).map(o => ({
            id: o.id,
            tradier_order_id: o.tradier_order_id,
            client_order_id: o.client_order_id,
            status: o.status,
            side: o.side,
          })),
        },
        consistency: {
          positions_match: positionsInSnapshot.length === latestSnapshot.positions_count,
          orders_match: ordersInSnapshot.length === latestSnapshot.orders_count,
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
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

