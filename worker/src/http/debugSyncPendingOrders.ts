/**
 * Debug endpoint to manually sync orders that are out of sync
 * This fixes orders that show FILLED in Tradier but PLACED in our database
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { getOrderByTradierOrderId, updateOrder } from '../db/queries_orders';
import { TradierClient } from '../broker/tradierClient';
import { reconcileOrderWithTrade } from '../engine/orderSyncNew';

export async function handleDebugSyncPendingOrders(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tradierOrderId = url.searchParams.get('tradier_order_id');
    const syncAll = url.searchParams.get('sync_all') === 'true';
    
    const db = getDB(env);
    const broker = new TradierClient(env);
    
    const results: any = {
      timestamp: new Date().toISOString(),
      synced: [] as any[],
      errors: [] as any[],
    };
    
    if (tradierOrderId) {
      // Sync a specific order
      try {
        const localOrder = await getOrderByTradierOrderId(env, tradierOrderId);
        if (!localOrder) {
          results.errors.push({
            tradier_order_id: tradierOrderId,
            error: 'Order not found in database',
          });
        } else {
          const tradierOrder = await broker.getOrder(tradierOrderId);
          
          // Map Tradier status
          const tradierStatusLower = (tradierOrder.status || '').toLowerCase();
          let mappedStatus: string;
          if (tradierStatusLower === 'filled') {
            mappedStatus = 'FILLED';
          } else if (tradierStatusLower === 'cancelled' || tradierStatusLower === 'canceled') {
            mappedStatus = 'CANCELLED';
          } else if (tradierStatusLower === 'rejected') {
            mappedStatus = 'REJECTED';
          } else if (tradierStatusLower === 'open' || tradierStatusLower === 'pending') {
            mappedStatus = 'PLACED';
          } else {
            mappedStatus = tradierOrder.status || 'UNKNOWN';
          }
          
          if (localOrder.status !== mappedStatus) {
            await updateOrder(env, localOrder.id, {
              status: mappedStatus as any,
              tradier_order_id: tradierOrder.id,
              avg_fill_price: tradierOrder.avg_fill_price || null,
              filled_quantity: tradierOrder.filled_quantity || 0,
              remaining_quantity: tradierOrder.remaining_quantity || 0,
            });
            
            // Reconcile with trade if terminal status
            if (['FILLED', 'CANCELLED', 'REJECTED'].includes(mappedStatus)) {
              await reconcileOrderWithTrade(env, localOrder.id);
            }
            
            results.synced.push({
              local_order_id: localOrder.id,
              tradier_order_id: tradierOrderId,
              old_status: localOrder.status,
              new_status: mappedStatus,
              avg_fill_price: tradierOrder.avg_fill_price || null,
              filled_quantity: tradierOrder.filled_quantity || 0,
            });
          } else {
            results.synced.push({
              local_order_id: localOrder.id,
              tradier_order_id: tradierOrderId,
              status: localOrder.status,
              note: 'Already in sync',
            });
          }
        }
      } catch (error) {
        results.errors.push({
          tradier_order_id: tradierOrderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (syncAll) {
      // Find all orders that might be out of sync
      const orders = await db.prepare(`
        SELECT * FROM orders 
        WHERE status = 'PLACED' 
        AND tradier_order_id IS NOT NULL
        AND created_at > datetime('now', '-7 days')
        ORDER BY created_at DESC
        LIMIT 50
      `).all();
      
      for (const order of (orders.results || [])) {
        try {
          const tradierOrder = await broker.getOrder(order.tradier_order_id);
          
          const tradierStatusLower = (tradierOrder.status || '').toLowerCase();
          let mappedStatus: string;
          if (tradierStatusLower === 'filled') {
            mappedStatus = 'FILLED';
          } else if (tradierStatusLower === 'cancelled' || tradierStatusLower === 'canceled') {
            mappedStatus = 'CANCELLED';
          } else if (tradierStatusLower === 'rejected') {
            mappedStatus = 'REJECTED';
          } else if (tradierStatusLower === 'open' || tradierStatusLower === 'pending') {
            mappedStatus = 'PLACED';
          } else {
            mappedStatus = tradierOrder.status || 'UNKNOWN';
          }
          
          if (order.status !== mappedStatus) {
            await updateOrder(env, order.id, {
              status: mappedStatus as any,
              tradier_order_id: tradierOrder.id,
              avg_fill_price: tradierOrder.avg_fill_price || null,
              filled_quantity: tradierOrder.filled_quantity || 0,
              remaining_quantity: tradierOrder.remaining_quantity || 0,
            });
            
            if (['FILLED', 'CANCELLED', 'REJECTED'].includes(mappedStatus)) {
              await reconcileOrderWithTrade(env, order.id);
            }
            
            results.synced.push({
              local_order_id: order.id,
              tradier_order_id: order.tradier_order_id,
              old_status: order.status,
              new_status: mappedStatus,
              avg_fill_price: tradierOrder.avg_fill_price || null,
              filled_quantity: tradierOrder.filled_quantity || 0,
            });
          }
        } catch (error) {
          results.errors.push({
            order_id: order.id,
            tradier_order_id: order.tradier_order_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      return new Response(
        JSON.stringify({
          error: 'Please provide tradier_order_id or set sync_all=true',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
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

