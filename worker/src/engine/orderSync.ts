/**
 * Order Sync Engine
 * 
 * Syncs all orders from Tradier with our database.
 * Ensures trade status matches order status (FILLED, REJECTED, CANCELLED, etc.)
 * 
 * SIMPLIFIED APPROACH (post-portfolio-sync):
 * - If trade has broker_order_id_open/close, we use order status from list (no detail fetch needed)
 * - Prices come from portfolio_positions, NOT from orders
 * - We only fetch order details for:
 *   1. Orphaned orders (to check if they're ours before cancelling)
 *   2. Backfilling missing order IDs (one-time operation)
 * - This dramatically reduces API calls and avoids D1 rate limits
 */

import type { Env } from '../env';
import type { TradeRow, BrokerOrder } from '../types';
import { TradierClient } from '../broker/tradierClient';
import {
  getOpenTrades,
  getTradesByStatus,
  updateTrade,
} from '../db/queries';
import { markTradeOpen, markTradeClosed, markTradeClosedWithReason, markTradeCancelled } from './lifecycle';
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
  errors: string[];
}> {
  const suppressOrphanedLogs = options?.suppressOrphanedLogs ?? false;
  const broker = new TradierClient(env);

  const result = {
    synced: 0,
    updated: 0,
    errors: [] as string[],
  };

  try {
    // 1. Fetch orders from Tradier (last 2 days - reduced to avoid D1 rate limits)
    // Recent orders are more important for status updates
    // CRITICAL: Processing too many orders causes "Too many API requests" D1 errors
    // We only need to sync recent orders for status updates - older orders are already synced
    // 
    // NOTE: This 2-day window is based on order creation date. If you use long-dated GTC orders
    // (e.g., created 3+ days ago but still OPEN), their status changes may not be captured.
    // For long-dated strategies, consider extending to 7-30 days or using updated_at filtering if available.
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 2); // Last 2 days only

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
    // CRITICAL: We need all non-terminal states (OPEN, ENTRY_PENDING, CLOSING_PENDING) to properly match orders
    // getOpenTrades() already includes these states, but we're being explicit here for safety
    // and to ensure we don't miss any trades if getOpenTrades() implementation changes
    const openTrades = await getOpenTrades(env);
    const pendingEntries = await getTradesByStatus(env, 'ENTRY_PENDING');
    const pendingExits = await getTradesByStatus(env, 'CLOSING_PENDING');
    // Deduplicate by trade ID (getOpenTrades may already include pending states)
    const tradeMap = new Map<string, TradeRow>();
    for (const trade of [...openTrades, ...pendingEntries, ...pendingExits]) {
      tradeMap.set(trade.id, trade);
    }
    const ourTrades = Array.from(tradeMap.values());

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

    // 4.5. Note: Trades without order IDs are handled in backfillMissingOrderIds
    // We don't try to match them here to avoid excessive API calls
    
    // 5. For each Tradier order, sync with our database
    // SIMPLIFIED: If we have an order ID in the trade, we don't need to fetch order details
    // We only fetch details for:
    // 1. Orphaned orders (to check if they're ours before cancelling)
    // 2. Backfilling missing order IDs (handled separately)
    
    // Track orphaned terminal orders for batched logging
    const orphanedTerminalOrders: Array<{ id: string; status: string; ageDays: number }> = [];
    
    for (const order of gekkoOrders) {
      result.synced++;

      const trade = orderIdToTrade.get(order.id);

      if (!trade) {
        // Order not matched by ID - treat as orphaned order
        // CRITICAL: We don't try to match by details here anymore - that's handled in backfillMissingOrderIds
        // This simplifies the logic and reduces API calls
        
        if (order.status === 'REJECTED' || order.status === 'CANCELLED' || order.status === 'EXPIRED') {
          // Already in terminal state - collect for batched logging
          // Only track if not suppressing orphaned logs (e.g., when called from trade cycle)
          if (!suppressOrphanedLogs) {
            const orderDate = order.created_at ? new Date(order.created_at) : null;
            const daysOld = orderDate ? (Date.now() - orderDate.getTime()) / (1000 * 60 * 60 * 24) : 999;
            // Only track recent orders (last 24 hours) to reduce log noise
            if (daysOld < 1) {
              orphanedTerminalOrders.push({
                id: order.id,
                status: order.status,
                ageDays: daysOld,
              });
            }
          }
        } else if (order.status === 'OPEN' || order.status === 'NEW') {
          // CRITICAL: Only cancel orphaned orders that are clearly ours (GEKKOWORKS tagged)
          // Never cancel manual or external orders - check tag first
          // NOTE: This is the ONLY place we fetch order details for unmatched orders
          try {
            const orderDetails = await broker.getOrderWithLegs(order.id);
            const tag = (orderDetails as any).tag || '';
            
            // Only cancel if order is tagged as GEKKOWORKS (our system's orders)
            if (!tag.includes('GEKKOWORKS')) {
              // External or manual order - log but don't cancel
              if (!suppressOrphanedLogs) {
                console.log('[orderSync] orphaned order is not GEKKOWORKS - skipping cancel', JSON.stringify({
                  orderId: order.id,
                  tag: tag || '(no tag)',
                  status: order.status,
                  note: 'This is likely a manual or external order - not cancelling',
                }));
              }
              continue;
            }
            
            // Order is ours - safe to cancel
            await broker.cancelOrder(order.id);
            result.updated++; // Count as updated since we cleaned it up
            console.log('[orderSync] cancelled orphaned GEKKOWORKS order', JSON.stringify({
              orderId: order.id,
              tag: tag,
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
        continue; // Skip to next order - no trade to sync
      }

      // We have a trade for this order - sync the status
      // SIMPLIFIED: We don't fetch order details here - we use the order status from the list
      // Prices come from portfolio_positions, not orders
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

    // 5.5. Log batched summary of orphaned terminal orders (reduce log noise)
    if (orphanedTerminalOrders.length > 0 && !suppressOrphanedLogs) {
      // Group by status for cleaner summary
      const byStatus: Record<string, number> = {};
      for (const o of orphanedTerminalOrders) {
        byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      }
      console.log('[orderSync] orphaned terminal orders summary', JSON.stringify({
        total: orphanedTerminalOrders.length,
        byStatus,
        note: 'These are old rejected/cancelled/expired orders that don\'t match any trades - expected and safe to ignore',
      }));
    }

    // 6. Backfill missing order IDs for trades that don't have them
    // CRITICAL: All trades are opened by the system, so we should be able to find their order IDs
    // This ensures we never have phantom trades - every trade should have an order ID
    // Only check orders that weren't already matched to trades
    const unmatchedOrders = gekkoOrders.filter(order => !orderIdToTrade.has(order.id));
    await backfillMissingOrderIds(env, broker, unmatchedOrders, result);

    console.log('[orderSync] sync complete', JSON.stringify({
      synced: result.synced,
      updated: result.updated,
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
 * Backfill missing order IDs for trades that don't have them
 * 
 * CRITICAL: All trades are opened by the system, so we should be able to find their order IDs.
 * This proactively searches for matching orders to ensure no trades are left without order IDs.
 * 
 * NOTE: This function only backfills broker_order_id_open (entry orders), not broker_order_id_close.
 * If an exit order's ID is missing, it will not be recovered by this function.
 * Exit order IDs should be set immediately when the exit order is placed in exits.ts.
 */
async function backfillMissingOrderIds(
  env: Env,
  broker: TradierClient,
  allOrders: BrokerOrder[],
  result: { synced: number; updated: number; errors: string[] }
): Promise<void> {
  try {
    // Get all trades that might be missing order IDs
    // Include OPEN, ENTRY_PENDING, and CLOSING_PENDING (but not CANCELLED or CLOSED)
    const openTrades = await getOpenTrades(env);
    const pendingEntries = await getTradesByStatus(env, 'ENTRY_PENDING');
    const pendingExits = await getTradesByStatus(env, 'CLOSING_PENDING');
    
    // Combine and filter to trades without order IDs
    const tradesWithoutOrderIds = [
      ...openTrades.filter(t => !t.broker_order_id_open),
      ...pendingEntries.filter(t => !t.broker_order_id_open),
      ...pendingExits.filter(t => !t.broker_order_id_open),
    ];
    
    if (tradesWithoutOrderIds.length === 0) {
      return; // No trades need backfilling
    }
    
    console.log('[orderSync][backfill] searching for missing order IDs', JSON.stringify({
      tradesNeedingBackfill: tradesWithoutOrderIds.length,
      tradeIds: tradesWithoutOrderIds.map(t => t.id),
    }));
    
    const { parseOptionSymbol } = await import('./portfolioSync');
    let backfilledCount = 0;
    
    // OPTIMIZATION: Filter orders to only recent ones (last 14 days) to reduce API calls
    const now = Date.now();
    const MAX_BACKFILL_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
    const recentOrders = allOrders.filter(order => {
      if (!order.created_at) return false;
      const orderAge = now - new Date(order.created_at).getTime();
      return orderAge <= MAX_BACKFILL_AGE_MS;
    });
    
    // OPTIMIZATION: Cache order details to avoid duplicate API calls across trades
    // Key: order ID, Value: order details (or null if fetch failed)
    const orderDetailsCache = new Map<string, any | null>();
    let totalOrderDetailFetches = 0;
    const MAX_TOTAL_ORDER_DETAIL_FETCHES = 100; // Total limit across all trades (doubled for testing)
    
    console.log('[orderSync][backfill] filtered orders', JSON.stringify({
      totalOrders: allOrders.length,
      recentOrders: recentOrders.length,
      maxOrderDetailFetches: MAX_TOTAL_ORDER_DETAIL_FETCHES,
      note: 'Orders will be prioritized by status (FILLED first) and date (newest first)',
    }));
    
    // OPTIMIZATION: Prioritize orders most likely to match before fetching details
    // 1. Sort by status (FILLED first - more likely to be entry orders)
    // 2. Sort by date (newest first - matching orders likely more recent)
    // 3. Skip orders already linked to trades (check trades first)
    const allTradesWithOrderIds = [
      ...openTrades.filter(t => t.broker_order_id_open),
      ...pendingEntries.filter(t => t.broker_order_id_open),
      ...pendingExits.filter(t => t.broker_order_id_open),
    ];
    const linkedOrderIds = new Set(allTradesWithOrderIds.map(t => t.broker_order_id_open).filter((id): id is string => id !== null));
    
    const prioritizedOrders = recentOrders
      .filter(order => !linkedOrderIds.has(order.id)) // Skip already linked orders
      .sort((a, b) => {
        // Priority 1: FILLED orders first (more likely to be entry orders)
        if (a.status === 'FILLED' && b.status !== 'FILLED') return -1;
        if (a.status !== 'FILLED' && b.status === 'FILLED') return 1;
        
        // Priority 2: Newest first (matching orders likely more recent)
        if (a.created_at && b.created_at) {
          const aTime = new Date(a.created_at).getTime();
          const bTime = new Date(b.created_at).getTime();
          return bTime - aTime; // Descending (newest first)
        }
        if (a.created_at) return -1;
        if (b.created_at) return 1;
        
        return 0;
      });
    
    // OPTIMIZATION: Pre-filter to GEKKOWORKS-ENTRY orders and fetch details once
    // This eliminates duplicate fetches when multiple trades check the same orders
    const entryOrders: BrokerOrder[] = [];
    for (const order of prioritizedOrders) {
      // Skip if we've hit the global limit
      if (totalOrderDetailFetches >= MAX_TOTAL_ORDER_DETAIL_FETCHES) {
        console.warn('[orderSync][backfill] hit global order details fetch limit', JSON.stringify({
          totalFetches: totalOrderDetailFetches,
          entryOrdersFound: entryOrders.length,
          ordersProcessed: entryOrders.length,
          remainingOrders: prioritizedOrders.length - entryOrders.length,
          note: 'Stopping to prevent excessive API calls',
        }));
        break;
      }
      
      // Check cache first
      if (orderDetailsCache.has(order.id)) {
        const cached = orderDetailsCache.get(order.id);
        if (cached && cached.tag && cached.tag.includes('GEKKOWORKS-ENTRY')) {
          entryOrders.push(order);
        }
        continue;
      }
      
      // Fetch order details
      try {
        totalOrderDetailFetches++;
        const orderDetails = await broker.getOrderWithLegs(order.id);
        orderDetailsCache.set(order.id, orderDetails);
        
        // Only include GEKKOWORKS-ENTRY orders
        const tag = orderDetails.tag || '';
        if (tag.includes('GEKKOWORKS-ENTRY')) {
          entryOrders.push(order);
        }
      } catch (orderDetailError) {
        // Cache the failure to avoid retrying
        orderDetailsCache.set(order.id, null);
        continue;
      }
    }
    
    console.log('[orderSync][backfill] pre-fetched entry orders', JSON.stringify({
      entryOrdersFound: entryOrders.length,
      totalOrderDetailFetches,
      tradesToMatch: tradesWithoutOrderIds.length,
      note: 'Order details cached to avoid duplicate fetches',
    }));
    
    // For each trade without an order ID, try to find a matching order
    for (const trade of tradesWithoutOrderIds) {
      try {
        let matchFound = false;
        
        // Search through pre-filtered GEKKOWORKS-ENTRY orders
        for (const order of entryOrders) {
          // Get cached order details (should already be in cache)
          const orderDetails = orderDetailsCache.get(order.id);
          if (!orderDetails) {
            continue; // Skip if fetch failed
          }
          
          try {
            // Parse option symbols from order legs
            if (!orderDetails.leg || !Array.isArray(orderDetails.leg)) {
              continue;
            }
            
            const legs = orderDetails.leg;
            const parsedLegs = legs
              .map((leg: any) => leg.option_symbol ? parseOptionSymbol(leg.option_symbol) : null)
              .filter((parsed: any) => parsed !== null);
            
            if (parsedLegs.length !== 2) {
              continue; // Not a spread order
            }
            
            const [leg1, leg2] = parsedLegs;
            
            // Check if this order matches the trade
            // Both legs must be from same underlying and expiration as trade
            if (leg1.underlying === trade.symbol &&
                leg1.expiration === trade.expiration &&
                leg1.type === leg2.type) {
              
              // Check if strikes match (order doesn't matter)
              const matches = 
                (trade.short_strike === leg1.strike && trade.long_strike === leg2.strike) ||
                (trade.short_strike === leg2.strike && trade.long_strike === leg1.strike);
              
              if (matches) {
                // Found a match! Link the order ID
                console.log('[orderSync][backfill] found matching order for trade', JSON.stringify({
                  tradeId: trade.id,
                  orderId: order.id,
                  symbol: trade.symbol,
                  expiration: trade.expiration,
                  short_strike: trade.short_strike,
                  long_strike: trade.long_strike,
                  orderStatus: order.status,
                  note: 'Backfilled missing broker_order_id_open',
                }));
                
                // CRITICAL: Ensure broker_order_id_open uses Tradier order ID
                if (!order.id) {
                  console.error('[orderSync][backfill] order missing ID', JSON.stringify({
                    tradeId: trade.id,
                    order: order,
                  }));
                  continue;
                }
                
                await updateTrade(env, trade.id, {
                  broker_order_id_open: order.id, // CRITICAL: Must use Tradier order ID
                });
                
                backfilledCount++;
                result.updated++;
                
                // Also sync the order status to the trade if it's filled
                if (order.status === 'FILLED') {
                  try {
                    await syncOrderToTrade(env, { ...trade, broker_order_id_open: order.id }, order);
                  } catch (syncError) {
                    // Log but don't fail - we've at least linked the order ID
                    console.warn('[orderSync][backfill] failed to sync order status after backfill', JSON.stringify({
                      tradeId: trade.id,
                      orderId: order.id,
                      error: syncError instanceof Error ? syncError.message : String(syncError),
                    }));
                  }
                }
                
                matchFound = true;
                break; // Found match, move to next trade
              }
            }
          } catch (matchError) {
            // Error during matching - log but continue
            console.warn('[orderSync][backfill] error matching order to trade', JSON.stringify({
              tradeId: trade.id,
              orderId: order.id,
              error: matchError instanceof Error ? matchError.message : String(matchError),
            }));
            continue;
          }
        }
        
        if (!matchFound) {
          console.log('[orderSync][backfill] no match found for trade', JSON.stringify({
            tradeId: trade.id,
            symbol: trade.symbol,
            expiration: trade.expiration,
            entryOrdersChecked: entryOrders.length,
            note: 'Searched pre-filtered entry orders but no match found',
          }));
        }
      } catch (tradeError) {
        // Error processing this trade - log but continue
        console.warn('[orderSync][backfill] error processing trade', JSON.stringify({
          tradeId: trade.id,
          error: tradeError instanceof Error ? tradeError.message : String(tradeError),
        }));
        result.errors.push(`Failed to backfill order ID for trade ${trade.id}: ${tradeError instanceof Error ? tradeError.message : String(tradeError)}`);
      }
    }
    
    if (backfilledCount > 0) {
      console.log('[orderSync][backfill] completed', JSON.stringify({
        backfilledCount,
        totalTradesChecked: tradesWithoutOrderIds.length,
      }));
    }
  } catch (error) {
    // Non-fatal - log but don't fail the entire sync
    console.error('[orderSync][backfill] error', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    result.errors.push(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
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
    } else if (isExitOrder) {
      // Handle exit orders for both CLOSING_PENDING and CLOSED trades
      if (order.status === 'FILLED') {
        if (order.avg_fill_price === null) {
          console.warn('[orderSync] exit order filled but no fill price', JSON.stringify({
            orderId: order.id,
            tradeId: trade.id,
            tradeStatus: trade.status,
          }));
          return;
        }

        if (trade.status === 'CLOSING_PENDING') {
          // Exit order filled - mark trade as closed
          // Use markTradeClosedWithReason to preserve the exit_reason from the trade
          // If trade.exit_reason is set (e.g., from monitoring decision), use it
          // Otherwise default to 'NORMAL_EXIT'
          const exitReasonToUse = trade.exit_reason || 'NORMAL_EXIT';
          
          const closedTrade = await markTradeClosedWithReason(
            env,
            trade.id,
            order.avg_fill_price,
            new Date(order.updated_at || new Date()),
            exitReasonToUse
          );

          // Record in risk system
          await recordTradeClosed(env, closedTrade);

          console.log('[orderSync] exit order filled, trade marked closed', JSON.stringify({
            orderId: order.id,
            tradeId: trade.id,
            fillPrice: order.avg_fill_price,
            realizedPnl: closedTrade.realized_pnl,
          }));
        } else if (trade.status === 'CLOSED' && !trade.exit_price) {
          // CRITICAL FIX: Trade is already closed but missing exit_price - backfill it
          // This happens when trades were closed through "already flat" or other paths
          // but the exit price wasn't captured at the time
          const exitReasonToUse = trade.exit_reason || 'NORMAL_EXIT';
          
          // Update the trade with exit_price and recalculate realized_pnl
          // We can't use markTradeClosedWithReason here since trade is already closed,
          // so we need to update directly
          const { updateTrade, getTrade } = await import('../db/queries');
          const updatedTrade = await getTrade(env, trade.id);
          
          if (updatedTrade && updatedTrade.entry_price && updatedTrade.entry_price > 0) {
            // Calculate realized_pnl from entry and exit prices
            const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
            const quantity = trade.quantity ?? 1;
            let realized_pnl: number;
            
            if (isDebitSpread) {
              // Debit: PnL = (exit_price - entry_price) * quantity
              realized_pnl = (order.avg_fill_price - updatedTrade.entry_price) * quantity;
            } else {
              // Credit: PnL = (entry_price - exit_price) * quantity
              realized_pnl = (updatedTrade.entry_price - order.avg_fill_price) * quantity;
            }
            
            await updateTrade(env, trade.id, {
              exit_price: order.avg_fill_price,
              realized_pnl: realized_pnl,
            });
            
            console.log('[orderSync] backfilled exit_price for closed trade', JSON.stringify({
              orderId: order.id,
              tradeId: trade.id,
              exitPrice: order.avg_fill_price,
              entryPrice: updatedTrade.entry_price,
              realizedPnl: realized_pnl,
              strategy: trade.strategy,
              quantity: quantity,
            }));
          } else {
            console.warn('[orderSync] cannot backfill exit_price - missing entry_price', JSON.stringify({
              orderId: order.id,
              tradeId: trade.id,
              entryPrice: updatedTrade?.entry_price,
            }));
          }
        }
      }
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
    // WARNING: Partial fills are NOT fully supported - we only track avg_fill_price
    // The system presumes "all-or-nothing" fills for spreads.
    // For partial exit orders, this logic does NOT handle quantity reconciliation.
    // If a spread order partially fills (e.g., only one leg fills), the trade will remain
    // in an inconsistent state. This is a known limitation and should be addressed
    // in a future spec change if partial fills are required.
    if (order.avg_fill_price !== null && order.avg_fill_price !== trade.entry_price) {
      // Partial fill or price update - update trade
      if (isEntryOrder && trade.status === 'ENTRY_PENDING') {
        // Update entry price if we have a partial fill
        await updateTrade(env, trade.id, {
          entry_price: order.avg_fill_price,
        });
        console.warn('[orderSync] updated entry price from order (partial fill)', JSON.stringify({
          orderId: order.id,
          tradeId: trade.id,
          newPrice: order.avg_fill_price,
          note: 'WARNING: Partial fill detected - quantity reconciliation NOT supported. Trade may be in inconsistent state if only one leg filled.',
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

