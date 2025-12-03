/**
 * New Order Sync System
 * 
 * Polls Tradier orders and updates our orders table based on client_order_id.
 * This makes Tradier the source of truth for order status.
 */

import type { Env } from '../env';
import type { BrokerOrder, OrderStatus } from '../types';
import { TradierClient } from '../broker/tradierClient';
import {
  getOrderByClientOrderId,
  getOrderByTradierOrderId,
  updateOrder,
  getRecentOrders,
} from '../db/queries_orders';
import { getProposal, updateProposal } from '../db/queries';
import { getTrade, updateTrade } from '../db/queries';
import { markTradeOpen, markTradeClosed } from './lifecycle';

/**
 * Map Tradier order status to our OrderStatus
 */
function mapTradierStatus(tradierStatus: string): OrderStatus {
  const status = tradierStatus.toLowerCase();
  switch (status) {
    case 'filled':
      return 'FILLED';
    case 'partially_filled':
    case 'partial':
      return 'PARTIAL';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'rejected':
      return 'REJECTED';
    case 'open':
    case 'pending':
      return 'PLACED';
    default:
      return 'PENDING';
  }
}

/**
 * Reconcile order with trade - update trade status based on order status
 */
export async function reconcileOrderWithTrade(env: Env, orderId: string): Promise<void> {
  const { getOrder } = await import('../db/queries_orders');
  const order = await getOrder(env, orderId);
  if (!order) {
    return;
  }

  // Only act when we have a terminal status
  if (!['FILLED', 'PARTIAL', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return;
  }

  const proposal = await getProposal(env, order.proposal_id);
  if (!proposal) {
    console.warn('[orderSync] proposal not found for order', JSON.stringify({
      orderId: order.id,
      proposalId: order.proposal_id,
    }));
    return;
  }

  // CRITICAL: Log strategy verification at order reconciliation
  console.log('[orderSync] reconciling order with trade', JSON.stringify({
    orderId: order.id,
    orderStatus: order.status,
    orderSide: order.side,
    proposalId: proposal.id,
    proposalStrategy: proposal.strategy,
    tradeId: order.trade_id,
    note: 'Strategy must match proposal strategy throughout lifecycle',
  }));

  let trade = order.trade_id ? await getTrade(env, order.trade_id) : null;

  if (order.side === 'ENTRY') {
    if (order.status === 'FILLED') {
      // Create or update trade as OPEN
      if (!trade) {
        // CRITICAL: Verify strategy before creating trade
        const tradeStrategy = proposal.strategy || 'BULL_PUT_CREDIT';
        console.log('[orderSync] creating trade from filled order', JSON.stringify({
          orderId: order.id,
          proposalId: proposal.id,
          proposalStrategy: proposal.strategy,
          tradeStrategy,
          strategyMatch: tradeStrategy === proposal.strategy,
          entryPrice: order.avg_fill_price,
          note: 'Trade strategy must match proposal strategy exactly',
        }));
        
        // Create trade from proposal and order
        const { insertTrade } = await import('../db/queries');
        trade = await insertTrade(env, {
          id: crypto.randomUUID(),
          proposal_id: proposal.id,
          symbol: proposal.symbol,
          expiration: proposal.expiration,
          short_strike: proposal.short_strike,
          long_strike: proposal.long_strike,
          width: proposal.width,
          quantity: proposal.quantity,
          strategy: tradeStrategy, // CRITICAL: Must match proposal strategy
          entry_price: order.avg_fill_price,
          status: 'OPEN',
          broker_order_id_open: order.tradier_order_id || order.id,
          opened_at: new Date().toISOString(),
          origin: 'ENGINE',
          managed: 1,
        });
        
        // CRITICAL: Verify strategy was persisted correctly
        if (trade.strategy !== proposal.strategy) {
          console.error('[orderSync] CRITICAL: Strategy mismatch after trade creation', JSON.stringify({
            tradeId: trade.id,
            proposalId: proposal.id,
            expectedStrategy: proposal.strategy,
            actualStrategy: trade.strategy,
            error: 'Strategy changed during trade creation - this should never happen',
          }));
        } else {
          console.log('[orderSync] trade created successfully', JSON.stringify({
            tradeId: trade.id,
            proposalId: proposal.id,
            strategy: trade.strategy,
            entryPrice: trade.entry_price,
            status: trade.status,
            note: 'Trade created with correct strategy from proposal',
          }));
        }
        
        // Link order to trade
        await updateOrder(env, order.id, { trade_id: trade.id });
      } else {
        // CRITICAL: Verify strategy matches before updating existing trade
        if (trade.strategy !== proposal.strategy) {
          console.error('[orderSync] CRITICAL: Strategy mismatch on existing trade', JSON.stringify({
            tradeId: trade.id,
            proposalId: proposal.id,
            tradeStrategy: trade.strategy,
            proposalStrategy: proposal.strategy,
            error: 'Existing trade has wrong strategy - this indicates a data corruption issue',
          }));
        }
        
        console.log('[orderSync] updating existing trade to OPEN', JSON.stringify({
          tradeId: trade.id,
          proposalId: proposal.id,
          tradeStrategy: trade.strategy,
          proposalStrategy: proposal.strategy,
          entryPrice: order.avg_fill_price,
          strategyMatch: trade.strategy === proposal.strategy,
        }));
        
        // Update existing trade
        await markTradeOpen(env, trade.id, order.avg_fill_price || trade.entry_price || 0);
        if (order.avg_fill_price) {
          await updateTrade(env, trade.id, {
            entry_price: order.avg_fill_price,
            broker_order_id_open: order.tradier_order_id || order.id,
          });
        }
      }
      
      // Update proposal
      await updateProposal(env, proposal.id, {
        status: 'CONSUMED',
        kind: 'ENTRY',
        client_order_id: order.client_order_id,
      });
    } else if (['CANCELLED', 'REJECTED'].includes(order.status)) {
      // Mark proposal as failed
      await updateProposal(env, proposal.id, {
        status: 'INVALIDATED',
      });
    }
  } else if (order.side === 'EXIT') {
    if (!trade) {
      console.warn('[orderSync] exit order has no trade', JSON.stringify({
        orderId: order.id,
        proposalId: order.proposal_id,
        tradeId: order.trade_id,
      }));
      return;
    }

    // Check for filled status (handle case variations and partial fills)
    const orderStatusUpper = (order.status || '').toUpperCase();
    const isFilled = orderStatusUpper === 'FILLED' || 
                    orderStatusUpper === 'FULLY_FILLED' ||
                    (order.filled_quantity && order.filled_quantity > 0 && order.remaining_quantity === 0);
    
    if (isFilled) {
      const fillPrice = order.avg_fill_price || trade.exit_price || 0;
      
      // Use markTradeClosedWithReason to preserve exit_reason if trade is in CLOSING_PENDING
      const { markTradeClosedWithReason } = await import('./lifecycle');
      const exitReason = trade.exit_reason || 'NORMAL_EXIT';
      
      console.log('[orderSync] closing trade from filled exit order', JSON.stringify({
        tradeId: trade.id,
        orderId: order.id,
        orderStatus: order.status,
        fillPrice,
        exitReason,
        tradeStatus: trade.status,
        note: 'Exit order filled - updating trade to CLOSED',
      }));
      
      await markTradeClosedWithReason(env, trade.id, fillPrice, new Date(), exitReason);
      
      if (order.avg_fill_price) {
        await updateTrade(env, trade.id, {
          exit_price: order.avg_fill_price,
          broker_order_id_close: order.tradier_order_id || order.id,
          closed_at: new Date().toISOString(),
        });
      }
      
      // Record in risk system
      const { recordTradeClosed } = await import('../core/risk');
      const updatedTrade = await getTrade(env, trade.id);
      if (updatedTrade) {
        await recordTradeClosed(env, updatedTrade);
      }
      
      // Update proposal
      await updateProposal(env, proposal.id, {
        status: 'CONSUMED',
        kind: 'EXIT',
      });
    } else if (['CANCELLED', 'REJECTED'].includes(order.status)) {
      // Exit failed - mark proposal but keep trade OPEN
      await updateProposal(env, proposal.id, {
        status: 'INVALIDATED',
      });
    }
  }
}

/**
 * Sync orders from Tradier
 * 
 * Polls Tradier for recent orders and updates our orders table.
 * Uses client_order_id to match Tradier orders to our local orders.
 */
export async function syncOrdersFromTradier(env: Env): Promise<{
  synced: number;
  updated: number;
  errors: string[];
}> {
  const result = {
    synced: 0,
    updated: 0,
    errors: [] as string[],
  };

  const broker = new TradierClient(env);

  try {
    // Fetch orders from Tradier (last 2 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 2);

    const tradierOrders = await broker.getAllOrders(
      'all',
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );

    console.log('[orderSyncNew] fetched orders from Tradier', JSON.stringify({
      count: tradierOrders.length,
    }));

    for (const tradierOrder of tradierOrders) {
      try {
        // Try to match by client_order_id first (most reliable)
        let localOrder = null;
        if (tradierOrder.client_order_id) {
          localOrder = await getOrderByClientOrderId(env, tradierOrder.client_order_id);
        }
        
        // Fallback: try to match by Tradier order ID
        if (!localOrder && tradierOrder.id) {
          localOrder = await getOrderByTradierOrderId(env, tradierOrder.id);
        }

        if (!localOrder) {
          // Order not in our DB - might be from before we started tracking, or manual order
          // Skip it for now (we could create it, but that's a separate feature)
          continue;
        }

        // Map Tradier status to our status
        const mappedStatus = mapTradierStatus(tradierOrder.status);

        // Update order if status changed
        if (localOrder.status !== mappedStatus ||
            localOrder.tradier_order_id !== tradierOrder.id ||
            localOrder.avg_fill_price !== tradierOrder.avg_fill_price ||
            localOrder.filled_quantity !== tradierOrder.filled_quantity) {
          
          console.log('[orderSyncNew] updating order status', JSON.stringify({
            localOrderId: localOrder.id,
            tradierOrderId: tradierOrder.id,
            clientOrderId: tradierOrder.client_order_id,
            oldStatus: localOrder.status,
            newStatus: mappedStatus,
            oldFillPrice: localOrder.avg_fill_price,
            newFillPrice: tradierOrder.avg_fill_price,
            filledQuantity: tradierOrder.filled_quantity,
            note: 'Order status changed - will reconcile with trade if filled',
          }));
          
          await updateOrder(env, localOrder.id, {
            status: mappedStatus,
            tradier_order_id: tradierOrder.id,
            avg_fill_price: tradierOrder.avg_fill_price,
            filled_quantity: tradierOrder.filled_quantity,
            remaining_quantity: tradierOrder.remaining_quantity,
          });

          result.updated++;

          // Reconcile with trade (this will create/update trade if order is FILLED)
          await reconcileOrderWithTrade(env, localOrder.id);
        }

        result.synced++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to sync order ${tradierOrder.id}: ${errorMsg}`);
        console.error('[orderSyncNew] error syncing order', JSON.stringify({
          tradierOrderId: tradierOrder.id,
          clientOrderId: tradierOrder.client_order_id,
          error: errorMsg,
        }));
      }
    }

    console.log('[orderSyncNew] sync complete', JSON.stringify({
      synced: result.synced,
      updated: result.updated,
      errors: result.errors.length,
    }));

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Sync failed: ${errorMsg}`);
    console.error('[orderSyncNew] sync error', JSON.stringify({
      error: errorMsg,
    }));
    return result;
  }
}

/**
 * Sync a single order from Tradier immediately after placement
 * This ensures we catch fills/rejections immediately rather than waiting for the next sync cycle
 */
export async function syncSingleOrderFromTradier(
  env: Env,
  tradierOrderId: string,
  clientOrderId?: string
): Promise<void> {
  const broker = new TradierClient(env);
  
  try {
    // Get order from Tradier
    const tradierOrder = await broker.getOrder(tradierOrderId);
    
    // Find local order by Tradier order ID or client_order_id
    let localOrder = null;
    if (clientOrderId) {
      localOrder = await getOrderByClientOrderId(env, clientOrderId);
    }
    if (!localOrder) {
      localOrder = await getOrderByTradierOrderId(env, tradierOrderId);
    }
    
    if (!localOrder) {
      console.warn('[orderSyncNew][syncSingle] order not found in database', JSON.stringify({
        tradierOrderId,
        clientOrderId,
        note: 'Order may not have been created yet - will sync on next cycle',
      }));
      return;
    }
    
    // Map Tradier status to our status
    const mappedStatus = mapTradierStatus(tradierOrder.status);
    
    // Update order if status changed
    if (localOrder.status !== mappedStatus ||
        localOrder.avg_fill_price !== tradierOrder.avg_fill_price ||
        localOrder.filled_quantity !== tradierOrder.filled_quantity) {
      
      console.log('[orderSyncNew][syncSingle] updating order status immediately', JSON.stringify({
        localOrderId: localOrder.id,
        tradierOrderId: tradierOrder.id,
        clientOrderId: tradierOrder.client_order_id || clientOrderId,
        oldStatus: localOrder.status,
        newStatus: mappedStatus,
        oldFillPrice: localOrder.avg_fill_price,
        newFillPrice: tradierOrder.avg_fill_price,
        filledQuantity: tradierOrder.filled_quantity,
        note: 'Immediate sync after order placement',
      }));
      
      await updateOrder(env, localOrder.id, {
        status: mappedStatus,
        tradier_order_id: tradierOrder.id,
        avg_fill_price: tradierOrder.avg_fill_price,
        filled_quantity: tradierOrder.filled_quantity,
        remaining_quantity: tradierOrder.remaining_quantity,
      });
      
      // Reconcile with trade if status changed to a terminal state
      if (['FILLED', 'CANCELLED', 'REJECTED'].includes(mappedStatus)) {
        await reconcileOrderWithTrade(env, localOrder.id);
      }
    }
  } catch (error) {
    // Log but don't throw - this is a best-effort sync
    console.warn('[orderSyncNew][syncSingle] error syncing order', JSON.stringify({
      tradierOrderId,
      clientOrderId,
      error: error instanceof Error ? error.message : String(error),
      note: 'Will be synced on next monitor cycle',
    }));
  }
}

