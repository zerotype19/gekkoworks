/**
 * Master Tradier Sync
 * 
 * Single orchestrator function that syncs all Tradier data into D1 in a coherent snapshot.
 * This replaces ad-hoc syncs (syncPortfolioFromTradier, syncOrdersFromTradier, etc.)
 * 
 * All sync operations should use this function to ensure consistency.
 */

import type { Env } from '../env';
import type { BrokerPosition, BrokerOrder } from '../types';
import { TradierClient } from '../broker/tradierClient';
import { getDB } from '../db/client';
import {
  upsertPortfolioPosition,
  deletePortfolioPositionsNotInSet,
} from '../db/queries';
import {
  getOrderByTradierOrderId,
  getOrderByClientOrderId,
  updateOrder,
} from '../db/queries_orders';
import { reconcileOrderWithTrade } from '../engine/orderSyncNew';
import { parseOptionSymbol } from '../engine/portfolioSync';
import { updatePositionsSyncTimestamp, updateOrdersSyncTimestamp, updateBalancesSyncTimestamp } from '../core/syncFreshness';
import { getTradingMode } from '../core/config';

export interface TradierSnapshot {
  snapshotId: string;
  asOf: string;
  accountId: string;
  balances: {
    cash: number;
    buying_power: number;
    equity: number;
    margin_requirement: number;
  };
  positions: BrokerPosition[];
  orders: BrokerOrder[];
  counts: {
    positions: number;
    orders: number;
  };
}

export interface TradierSnapshotResult {
  success: boolean;
  snapshot: TradierSnapshot | null;
  errors: string[];
  warnings: string[];
}

/**
 * Sync complete Tradier snapshot into D1
 * 
 * This function:
 * 1. Fetches account, balances, positions, and orders from Tradier (in parallel where possible)
 * 2. Generates a snapshotId and asOf timestamp
 * 3. Writes everything to D1 with the shared snapshotId
 * 4. Returns the normalized snapshot
 * 
 * @param env Environment
 * @param accountId Optional account ID (defaults to TRADIER_ACCOUNT_ID from env)
 */
export async function syncTradierSnapshot(
  env: Env,
  accountId?: string
): Promise<TradierSnapshotResult> {
  const snapshotId = crypto.randomUUID();
  const asOf = new Date().toISOString();
  const targetAccountId = accountId || env.TRADIER_ACCOUNT_ID;
  
  const result: TradierSnapshotResult = {
    success: false,
    snapshot: null,
    errors: [],
    warnings: [],
  };
  
  console.log('[tradier_sync:start]', JSON.stringify({
    accountId: targetAccountId,
    snapshotId,
    asOf,
  }));
  
  const broker = new TradierClient(env);
  const mode = await getTradingMode(env);
  const db = getDB(env);
  
  try {
    // Step 1: Fetch all data from Tradier (in parallel where possible)
    const [balances, positions, orders] = await Promise.all([
      broker.getBalances().catch(err => {
        result.warnings.push(`Balances fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
      broker.getPositions().catch(err => {
        result.errors.push(`Positions fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }),
      broker.getAllOrders(
        'all',
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Last 7 days
        new Date().toISOString().split('T')[0]
      ).catch(err => {
        result.warnings.push(`Orders fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }),
    ]);
    
    // If critical operations failed, abort
    // Note: positions will be [] (not null) if fetch fails due to catch handler
    if (positions.length === 0 && result.errors.length > 0) {
      throw new Error(`Failed to fetch positions: ${result.errors.join(', ')}`);
    }
    
    console.log('[tradier_sync:counts]', JSON.stringify({
      snapshotId,
      positions: positions.length,
      orders: orders.length,
      balances: balances !== null,
    }));
    
    // Step 2: Write snapshot metadata
    // Wrap in try-catch to handle table not existing gracefully (migration might not have run)
    try {
      await db.prepare(`
        INSERT INTO tradier_snapshots (
          id, account_id, as_of, positions_count, orders_count,
          balances_cash, balances_buying_power, balances_equity, balances_margin_requirement,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        snapshotId,
        targetAccountId,
        asOf,
        positions.length,
        orders.length,
        balances?.cash ?? null,
        balances?.buying_power ?? null,
        balances?.equity ?? null,
        balances?.margin_requirement ?? null,
        asOf
      ).run();
    } catch (dbError) {
      const dbErrorMsg = dbError instanceof Error ? dbError.message : String(dbError);
      // If table doesn't exist, log warning but continue (migration might not have run)
      if (dbErrorMsg.includes('no such table') || dbErrorMsg.includes('does not exist')) {
        result.warnings.push(`tradier_snapshots table not found - migration may not have run: ${dbErrorMsg}`);
        console.warn('[tradier_sync:db_warning]', JSON.stringify({
          snapshotId,
          warning: 'tradier_snapshots table not found - continuing without snapshot tracking',
          error: dbErrorMsg,
        }));
      } else {
        // Other DB errors should be logged as errors
        result.errors.push(`Failed to write snapshot metadata: ${dbErrorMsg}`);
        throw dbError; // Re-throw to be caught by outer catch
      }
    }
    
    // Step 3: Write balances (if available)
    if (balances) {
      try {
        await db.prepare(`
          INSERT INTO account_balances (
            id, account_id, snapshot_id, cash, buying_power, equity, margin_requirement,
            as_of, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          targetAccountId,
          snapshotId,
          balances.cash,
          balances.buying_power,
          balances.equity,
          balances.margin_requirement,
          asOf,
          asOf
        ).run();
      } catch (dbError) {
        const dbErrorMsg = dbError instanceof Error ? dbError.message : String(dbError);
        // If table doesn't exist, log warning but continue
        if (dbErrorMsg.includes('no such table') || dbErrorMsg.includes('does not exist')) {
          result.warnings.push(`account_balances table not found - migration may not have run: ${dbErrorMsg}`);
        } else {
          result.warnings.push(`Failed to write balances snapshot: ${dbErrorMsg}`);
        }
      }
      
      // Update sync freshness timestamp
      await updateBalancesSyncTimestamp(env);
    }
    
    // Step 4: Sync positions to portfolio_positions
    const positionKeys: Array<{
      symbol: string;
      expiration: string;
      option_type: 'call' | 'put';
      strike: number;
      side: 'long' | 'short';
    }> = [];
    
    for (const position of positions) {
      const parsed = parseOptionSymbol(position.symbol);
      if (!parsed) {
        // Not an option position (e.g., stock, ETF) - skip
        continue;
      }
      
      // Determine side from quantity (positive = long, negative = short)
      const side: 'long' | 'short' = position.quantity > 0 ? 'long' : 'short';
      const quantity = Math.abs(position.quantity);
      
      // Get current bid/ask from option chain for accurate pricing
      let bid: number | null = null;
      let ask: number | null = null;
      let lastPrice: number | null = position.cost_basis_per_contract || null;
      
      try {
        const optionChain = await broker.getOptionChain(parsed.underlying, parsed.expiration);
        const option = optionChain.find(
          opt => opt.strike === parsed.strike && opt.type === parsed.type
        );
        if (option) {
          bid = option.bid;
          ask = option.ask;
          lastPrice = option.last || lastPrice;
        }
      } catch (err) {
        // Option chain fetch failed - use existing prices
        result.warnings.push(`Failed to fetch option chain for ${position.symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
      
      const positionKey = {
        symbol: parsed.underlying,
        expiration: parsed.expiration,
        option_type: parsed.type,
        strike: parsed.strike,
        side,
      };
      
      positionKeys.push(positionKey);
      
      // Upsert position (upsertPortfolioPosition doesn't support snapshot_id yet, so we do it manually)
      const positionId = `${positionKey.symbol}:${positionKey.expiration}:${positionKey.option_type}:${positionKey.strike}:${positionKey.side}`;
      await db.prepare(`
        INSERT OR REPLACE INTO portfolio_positions (
          id, symbol, expiration, option_type, strike, side, quantity,
          cost_basis_per_contract, last_price, bid, ask, snapshot_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        positionId,
        positionKey.symbol,
        positionKey.expiration,
        positionKey.option_type,
        positionKey.strike,
        positionKey.side,
        quantity,
        position.cost_basis_per_contract || null,
        lastPrice,
        bid,
        ask,
        snapshotId,
        asOf
      ).run();
    }
    
    // Delete positions not in this snapshot (they were closed)
    const deletedCount = await deletePortfolioPositionsNotInSet(env, positionKeys);
    if (deletedCount > 0) {
      console.log('[tradier_sync:positions]', JSON.stringify({
        snapshotId,
        deleted_stale_positions: deletedCount,
        note: 'Deleted positions that were not in Tradier response (closed positions)',
      }));
    }
    
    // Update sync freshness timestamp
    await updatePositionsSyncTimestamp(env);
    
    // Step 5: Sync orders (similar to orderSyncNew logic)
    let syncedOrders = 0;
    let updatedOrders = 0;
    
    let unmatchedOrders = 0;
    const unmatchedOrderIds: string[] = [];
    
    for (const tradierOrder of orders) {
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
          // Order not in our DB - this shouldn't happen if all orders come from Gekkoworks
          unmatchedOrders++;
          if (unmatchedOrderIds.length < 10) {
            unmatchedOrderIds.push(tradierOrder.id);
          }
          console.warn('[tradier_sync:order_unmatched]', JSON.stringify({
            tradierOrderId: tradierOrder.id,
            clientOrderId: tradierOrder.client_order_id,
            status: tradierOrder.status,
            created: tradierOrder.created_at,
            note: 'Order in Tradier but not found in local DB - all orders should come from Gekkoworks',
          }));
          continue;
        }
        
        // Map Tradier status to our status
        const mappedStatus = mapTradierOrderStatus(tradierOrder.status);
        
        // Update order if status or other fields changed
        const needsUpdate = 
          localOrder.status !== mappedStatus ||
          localOrder.tradier_order_id !== tradierOrder.id ||
          localOrder.avg_fill_price !== tradierOrder.avg_fill_price ||
          localOrder.filled_quantity !== tradierOrder.filled_quantity ||
          localOrder.remaining_quantity !== tradierOrder.remaining_quantity;
        
        if (needsUpdate) {
          await updateOrder(env, localOrder.id, {
            status: mappedStatus,
            tradier_order_id: tradierOrder.id,
            avg_fill_price: tradierOrder.avg_fill_price,
            filled_quantity: tradierOrder.filled_quantity,
            remaining_quantity: tradierOrder.remaining_quantity,
            updated_at: tradierOrder.updated_at || asOf,
          });
          
          updatedOrders++;
          
          // Reconcile with trade (this will create/update trade if order is FILLED)
          await reconcileOrderWithTrade(env, localOrder.id);
        }
        
        // Update snapshot_id for this order
        await db.prepare(`
          UPDATE orders SET snapshot_id = ? WHERE id = ?
        `).bind(snapshotId, localOrder.id).run();
        
        syncedOrders++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to sync order ${tradierOrder.id}: ${errorMsg}`);
        console.error('[tradier_sync:order_error]', JSON.stringify({
          tradierOrderId: tradierOrder.id,
          clientOrderId: tradierOrder.client_order_id,
          error: errorMsg,
        }));
      }
    }
    
    // Update sync freshness timestamp
    await updateOrdersSyncTimestamp(env);
    
    // Bulk update: Set snapshot_id for all orders that have a tradier_order_id matching any order in this sync
    // This catches orders that might not have matched individually but still exist in our DB
    if (orders.length > 0) {
      const tradierOrderIds = orders.map(o => o.id).filter(id => id != null);
      if (tradierOrderIds.length > 0) {
        // Update in batches to avoid SQL parameter limits (SQLite limit is ~999)
        const batchSize = 500;
        for (let i = 0; i < tradierOrderIds.length; i += batchSize) {
          const batch = tradierOrderIds.slice(i, i + batchSize);
          const placeholders = batch.map(() => '?').join(',');
          try {
            const bulkUpdateResult = await db.prepare(`
              UPDATE orders
              SET snapshot_id = ?
              WHERE tradier_order_id IN (${placeholders})
            `).bind(snapshotId, ...batch).run();
            
            if (bulkUpdateResult.meta.changes > 0) {
              console.log('[tradier_sync:bulk_update]', JSON.stringify({
                snapshotId,
                batch_size: batch.length,
                orders_updated: bulkUpdateResult.meta.changes,
                note: 'Bulk updated snapshot_id for orders matching Tradier order IDs',
              }));
            }
          } catch (bulkError) {
            result.warnings.push(`Bulk update failed for batch ${i / batchSize + 1}: ${bulkError instanceof Error ? bulkError.message : String(bulkError)}`);
          }
        }
      }
    }
    
    if (unmatchedOrders > 0) {
      result.warnings.push(`${unmatchedOrders} orders in Tradier not found in local DB (sample IDs: ${unmatchedOrderIds.slice(0, 5).join(', ')})`);
      console.warn('[tradier_sync:orders_unmatched]', JSON.stringify({
        snapshotId,
        unmatched_count: unmatchedOrders,
        total_tradier_orders: orders.length,
        matched_orders: syncedOrders,
        sample_unmatched_ids: unmatchedOrderIds.slice(0, 10),
        note: 'All orders should come from Gekkoworks - investigate why these are missing',
      }));
    }
    
    console.log('[tradier_sync:done]', JSON.stringify({
      accountId: targetAccountId,
      snapshotId,
      positions_synced: positions.length,
      orders_synced: syncedOrders,
      orders_updated: updatedOrders,
      orders_unmatched: unmatchedOrders,
      balances_synced: balances !== null,
      errors: result.errors.length,
      warnings: result.warnings.length,
    }));
    
    result.success = true;
    result.snapshot = {
      snapshotId,
      asOf,
      accountId: targetAccountId,
      balances: balances || {
        cash: 0,
        buying_power: 0,
        equity: 0,
        margin_requirement: 0,
      },
      positions,
      orders,
      counts: {
        positions: positions.length,
        orders: orders.length,
      },
    };
    
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Sync failed: ${errorMsg}`);
    
    console.error('[tradier_sync:error]', JSON.stringify({
      accountId: targetAccountId,
      snapshotId,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
    }));
    
    return result;
  }
}

/**
 * Map Tradier order status to our OrderStatus
 */
function mapTradierOrderStatus(tradierStatus: string): 'PENDING' | 'PLACED' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED' {
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
    case 'new':
      return 'PLACED';
    default:
      return 'PENDING';
  }
}

