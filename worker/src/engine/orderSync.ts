/**
 * Order Sync Engine
 * 
 * Syncs all orders from Tradier with our database.
 * Ensures trade status matches order status (FILLED, REJECTED, CANCELLED, etc.)
 */

import type { Env } from '../env';
import type { TradeRow, BrokerOrder } from '../types';
import { TradierClient } from '../broker/tradierClient';
import {
  getOpenTrades,
  updateTrade,
} from '../db/queries';
import { markTradeOpen, markTradeClosed, markTradeCancelled } from './lifecycle';
import { recordTradeClosed } from '../core/risk';
import { updateOrdersSyncTimestamp } from '../core/syncFreshness';

/**
 * Sync all orders from Tradier
 * 
 * Fetches all orders from Tradier and reconciles with our database:
 * - Updates trade status based on order status
 * - Cleans up orphaned orders (orders in Tradier but not in our DB) by cancelling OPEN/NEW orders
 * - Updates fill prices, status, etc.
 * 
 * Note: This function does NOT create trade records from orphaned orders.
 * Orphaned orders are either ignored (if terminal) or cancelled (if OPEN/NEW).
 */
export async function syncOrdersFromTradier(
  env: Env,
  options?: { suppressOrphanedLogs?: boolean }
): Promise<{
  synced: number;
  updated: number;
  created: number;
  errors: string[];
}> {
  const suppressOrphanedLogs = options?.suppressOrphanedLogs ?? false;
  const broker = new TradierClient(env);

  const result = {
    synced: 0,
    updated: 0,
    created: 0,
    errors: [] as string[],
  };

  try {
    // 1. Fetch all orders from Tradier (last 7 days - reduced from 30 to avoid timeout)
    // Recent orders are more important for status updates
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7); // Last 7 days

    const orders = await broker.getAllOrders(
      'all',
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );

    console.log('[orderSync] getAllOrders returned', JSON.stringify({
      count: orders.length,
      dateRange: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      },
    }));

    if (orders.length === 0) {
      console.log('[orderSync] no orders in Tradier for date range', JSON.stringify({
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0],
      }));
      return result;
    }

    console.log('[orderSync] fetched orders from Tradier', JSON.stringify({
      count: orders.length,
      orders: orders.slice(0, 10).map(o => ({ // Log first 10
        id: o.id,
        status: o.status,
        filled: o.filled_quantity > 0,
        avgFillPrice: o.avg_fill_price,
        created: o.created_at,
        updated: o.updated_at,
      })),
    }));

    // 2. For now, sync all orders and match by order ID
    // Note: We can't filter by tag in the list endpoint, but we can check individual orders
    // For efficiency, we'll sync all orders that match our order IDs
    const gekkoOrders = orders;

    // 3. Get all open trades (only need to match orders to currently live trades)
    // Using getOpenTrades instead of getAllTrades to avoid missing trades beyond limit
    // and to focus on trades that could have active orders
    const ourTrades = await getOpenTrades(env);

    // 4. Create a map of order ID -> trade
    const orderIdToTrade = new Map<string, TradeRow>();
    for (const trade of ourTrades) {
      if (trade.broker_order_id_open) {
        orderIdToTrade.set(trade.broker_order_id_open, trade);
      }
      if (trade.broker_order_id_close) {
        orderIdToTrade.set(trade.broker_order_id_close, trade);
      }
    }

    // 5. For each Tradier order, sync with our database
    for (const order of gekkoOrders) {
      result.synced++;

      const trade = orderIdToTrade.get(order.id);

      if (!trade) {
        // Orphaned order - we don't have a trade for this order ID
        // This could be an order placed outside our system or before we started tracking
        // If it's REJECTED, CANCELLED, or EXPIRED, we can safely ignore it
        // If it's still OPEN or NEW, we should cancel it to clean up
        if (order.status === 'REJECTED' || order.status === 'CANCELLED' || order.status === 'EXPIRED') {
          // Already in terminal state - just log and skip
          // Only log if not suppressing orphaned logs (e.g., when called from trade cycle)
          if (!suppressOrphanedLogs) {
            // Reduced logging verbosity - only log if it's a recent order (last 7 days)
            const orderDate = order.created_at ? new Date(order.created_at) : null;
            const daysOld = orderDate ? (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24) : 999;
            if (daysOld < 7) {
              console.log('[orderSync] orphaned terminal order', JSON.stringify({
                orderId: order.id,
                status: order.status,
                ageDays: daysOld.toFixed(1),
              }));
            }
          }
          continue;
        }
        
        // For OPEN or NEW orphaned orders, attempt to cancel them
        if (order.status === 'OPEN' || order.status === 'NEW') {
          try {
            await broker.cancelOrder(order.id);
            result.updated++; // Count as updated since we cleaned it up
            console.log('[orderSync] cancelled orphaned order', JSON.stringify({
              orderId: order.id,
              previousStatus: order.status,
            }));
          } catch (cancelError) {
            // If cancel fails, it might already be filled or cancelled - log but don't fail
            const errorMsg = cancelError instanceof Error ? cancelError.message : String(cancelError);
            console.warn('[orderSync] failed to cancel orphaned order', JSON.stringify({
              orderId: order.id,
              error: errorMsg,
            }));
          }
        }
        continue;
      }

      // We have a trade for this order - sync the status
      try {
        await syncOrderToTrade(env, trade, order);
        result.updated++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to sync order ${order.id} to trade ${trade.id}: ${errorMsg}`);
        console.error('[orderSync] error syncing order', JSON.stringify({
          orderId: order.id,
          tradeId: trade.id,
          error: errorMsg,
        }));
      }
    }

    console.log('[orderSync] sync complete', JSON.stringify({
      synced: result.synced,
      updated: result.updated,
      created: result.created,
      errors: result.errors.length,
    }));

    // Update sync freshness timestamp on successful sync
    // Only update if no errors (or only non-fatal errors)
    if (result.errors.length === 0) {
      await updateOrdersSyncTimestamp(env);
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Order sync failed: ${errorMsg}`);
    console.error('[orderSync] sync error', JSON.stringify({
      error: errorMsg,
    }));
    // Don't update timestamp on error - sync failed
    return result;
  }
}

/**
 * Sync a single order to its corresponding trade
 */
async function syncOrderToTrade(
  env: Env,
  trade: TradeRow,
  order: BrokerOrder
): Promise<void> {
  // Determine if this is an entry or exit order
  const isEntryOrder = trade.broker_order_id_open === order.id;
  const isExitOrder = trade.broker_order_id_close === order.id;

  if (!isEntryOrder && !isExitOrder) {
    // Order doesn't match this trade - shouldn't happen, but skip
    return;
  }

  // Handle different order statuses
  if (order.status === 'FILLED') {
    if (isEntryOrder) {
      // Entry order filled
      if (order.avg_fill_price === null) {
        console.warn('[orderSync] entry order filled but no fill price', JSON.stringify({
          orderId: order.id,
          tradeId: trade.id,
        }));
        return;
      }

      if (trade.status === 'ENTRY_PENDING') {
        // Trade still pending - mark as open
        await markTradeOpen(env, trade.id, order.avg_fill_price, new Date(order.updated_at || new Date()));
        console.log('[orderSync] entry order filled, trade marked open', JSON.stringify({
          orderId: order.id,
          tradeId: trade.id,
          fillPrice: order.avg_fill_price,
        }));
      } else if (trade.status === 'OPEN' && (!trade.entry_price || trade.entry_price <= 0)) {
        // Trade is already OPEN but missing entry_price - backfill it
        // Use markTradeOpen to maintain lifecycle invariants (validation, notifications, etc.)
        console.log('[orderSync] backfilling entry_price from filled order via markTradeOpen', JSON.stringify({
          orderId: order.id,
          tradeId: trade.id,
          fillPrice: order.avg_fill_price,
          current_entry_price: trade.entry_price,
          note: 'Using markTradeOpen to maintain lifecycle invariants',
        }));
        // markTradeOpen will compute max_profit/max_loss correctly for debit vs credit spreads
        // and run all lifecycle checks (validation, notifications, etc.)
        await markTradeOpen(
          env,
          trade.id,
          order.avg_fill_price,
          new Date(order.updated_at || new Date())
        );
      }
    } else if (isExitOrder && trade.status === 'CLOSING_PENDING') {
      // Exit order filled - mark trade as closed
      if (order.avg_fill_price === null) {
        console.warn('[orderSync] exit order filled but no fill price', JSON.stringify({
          orderId: order.id,
          tradeId: trade.id,
        }));
        return;
      }

      const closedTrade = await markTradeClosed(
        env,
        trade.id,
        order.avg_fill_price,
        new Date(order.updated_at || new Date())
      );

      // Record in risk system
      await recordTradeClosed(env, closedTrade);

      console.log('[orderSync] exit order filled, trade marked closed', JSON.stringify({
        orderId: order.id,
        tradeId: trade.id,
        fillPrice: order.avg_fill_price,
        realizedPnl: closedTrade.realized_pnl,
      }));
    }
  } else if (order.status === 'REJECTED' || order.status === 'CANCELLED' || order.status === 'EXPIRED') {
    if (isEntryOrder && trade.status === 'ENTRY_PENDING') {
      // Entry order rejected/cancelled - mark trade as cancelled
      await markTradeCancelled(env, trade.id, `Order ${order.status.toLowerCase()}`);
      console.log('[orderSync] entry order rejected/cancelled', JSON.stringify({
        orderId: order.id,
        tradeId: trade.id,
        status: order.status,
      }));
    } else if (isExitOrder && trade.status === 'CLOSING_PENDING') {
      // Exit order rejected/cancelled - exit engine will handle retry
      // Don't use markTradeCancelled here - let exit engine decide on retry/abort
      // Log context for debugging why exit failed
      const rejectReason = (order as any).reject_reason || 'unknown';
      console.log('[orderSync] exit order rejected/cancelled', JSON.stringify({
        orderId: order.id,
        tradeId: trade.id,
        status: order.status,
        reject_reason: rejectReason,
        exit_reason: trade.exit_reason,
        note: 'Exit engine will handle retry on next monitoring cycle',
      }));
    }
  } else if (order.status === 'OPEN' || order.status === 'NEW') {
    // Order still pending - update trade if needed (e.g., update fill price if partial fill)
    // Note: Partial fills are not fully supported - we only track avg_fill_price
    // For partial exit orders, this logic does not handle quantity reconciliation
    if (order.avg_fill_price !== null && order.avg_fill_price !== trade.entry_price) {
      // Partial fill or price update - update trade
      if (isEntryOrder && trade.status === 'ENTRY_PENDING') {
        // Update entry price if we have a partial fill
        await updateTrade(env, trade.id, {
          entry_price: order.avg_fill_price,
        });
        console.log('[orderSync] updated entry price from order', JSON.stringify({
          orderId: order.id,
          tradeId: trade.id,
          newPrice: order.avg_fill_price,
          note: 'Partial fill handling - quantity reconciliation not supported',
        }));
      }
    }
  } else {
    // Handle other statuses (PENDING, PARTIAL, etc.) - log for debugging
    console.log('[orderSync] unhandled order status', JSON.stringify({
      orderId: order.id,
      tradeId: trade.id,
      status: order.status,
      isEntryOrder,
      isExitOrder,
      tradeStatus: trade.status,
      note: 'Status not explicitly handled - may need future support',
    }));
  }
}

