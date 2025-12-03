/**
 * Actively track all open orders from Tradier using the Order API
 * 
 * This function polls Tradier's order API to get all open orders and
 * ensures our local database is in sync with the broker's order status.
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getOrderByTradierOrderId, updateOrder } from '../db/queries_orders';
import { getTrade } from '../db/queries';
import { reconcileOrderWithTrade, syncSingleOrderFromTradier } from './orderSyncNew';

export async function trackOpenOrdersFromTradier(env: Env, now: Date): Promise<void> {
  const broker = new TradierClient(env);
  
  try {
    console.log('[trackOpenOrders][start]', JSON.stringify({
      timestamp: now.toISOString(),
      note: 'Getting all open orders from Tradier order API',
    }));
    
    // Get all open orders from Tradier using the order API
    const openOrders = await broker.getOpenOrders();
    
    console.log('[trackOpenOrders][fetched]', JSON.stringify({
      open_orders_count: openOrders.length,
      order_ids: openOrders.map(o => o.id),
      timestamp: now.toISOString(),
    }));
    
    if (openOrders.length === 0) {
      console.log('[trackOpenOrders][complete]', JSON.stringify({
        open_orders_count: 0,
        note: 'No open orders found in Tradier',
        timestamp: now.toISOString(),
      }));
      return;
    }
    
    // Track each open order
    for (const tradierOrder of openOrders) {
      try {
        console.log('[trackOpenOrders][processing]', JSON.stringify({
          tradier_order_id: tradierOrder.id,
          status: tradierOrder.status,
          filled_quantity: tradierOrder.filled_quantity,
          remaining_quantity: tradierOrder.remaining_quantity,
          timestamp: now.toISOString(),
        }));
        
        // Get full order details using getOrderWithLegs for complete information
        const orderDetails = await broker.getOrderWithLegs(tradierOrder.id);
        
        // Find our local order record
        const localOrder = await getOrderByTradierOrderId(env, tradierOrder.id);
        
        // Get detailed status from Tradier
        const detailedOrder = await broker.getOrder(tradierOrder.id);
        
        console.log('[trackOpenOrders][order-details]', JSON.stringify({
          tradier_order_id: tradierOrder.id,
          local_order_exists: !!localOrder,
          tradier_status: detailedOrder.status,
          raw_tradier_status: detailedOrder.raw_tradier_status,
          filled_quantity: detailedOrder.filled_quantity,
          remaining_quantity: detailedOrder.remaining_quantity,
          avg_fill_price: detailedOrder.avg_fill_price,
          created_at: orderDetails.created_at || orderDetails.create_date || 'unknown',
          order_type: orderDetails.type,
          order_class: orderDetails.class,
          timestamp: now.toISOString(),
          note: 'Using Tradier order API to get complete order status',
        }));
        
        // If we have a local order, sync it with Tradier's status
        if (localOrder) {
          // Check if status needs updating
          if (localOrder.status !== detailedOrder.status) {
            console.log('[trackOpenOrders][status-mismatch]', JSON.stringify({
              tradier_order_id: tradierOrder.id,
              local_order_id: localOrder.id,
              local_status: localOrder.status,
              tradier_status: detailedOrder.status,
              note: 'Local order status differs from Tradier - syncing',
            }));
            
            // Update local order status
            await updateOrder(env, localOrder.id, {
              status: detailedOrder.status as any,
              avg_fill_price: detailedOrder.avg_fill_price,
              filled_quantity: detailedOrder.filled_quantity,
              remaining_quantity: detailedOrder.remaining_quantity,
            });
            
            // If order is in terminal state, reconcile with trade
            if (['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(detailedOrder.status)) {
              await reconcileOrderWithTrade(env, localOrder.id);
            }
          }
        } else {
          // No local order found - this might be an order we haven't tracked yet
          console.warn('[trackOpenOrders][orphan-order]', JSON.stringify({
            tradier_order_id: tradierOrder.id,
            status: detailedOrder.status,
            note: 'Open order in Tradier but not in local database - may need manual investigation',
          }));
        }
        
        // For filled or terminal orders, ensure we reconcile with trades
        if (localOrder && ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(detailedOrder.status)) {
          // Sync the order one more time to ensure everything is updated
          await syncSingleOrderFromTradier(env, tradierOrder.id);
        }
        
      } catch (err) {
        console.error('[trackOpenOrders][error]', JSON.stringify({
          tradier_order_id: tradierOrder.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: now.toISOString(),
        }));
        // Continue processing other orders
      }
    }
    
    console.log('[trackOpenOrders][complete]', JSON.stringify({
      open_orders_processed: openOrders.length,
      timestamp: now.toISOString(),
      note: 'Completed tracking all open orders from Tradier order API',
    }));
    
  } catch (err) {
    console.error('[trackOpenOrders][fatal-error]', JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      timestamp: now.toISOString(),
    }));
    // Don't throw - this is monitoring, shouldn't break the cycle
  }
}

