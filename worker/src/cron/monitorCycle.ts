/**
 * SAS v1 Monitor Cycle
 * 
 * Runs frequently to monitor open trades and execute exits.
 * Per architecture.md and monitoring.md.
 */

import type { Env } from '../env';
import { getOpenTrades, getTradesByStatus, updateTrade, setSetting, getSpreadLegPositions } from '../db/queries';
import { evaluateOpenTrade } from '../engine/monitoring';
import { executeExitForTrade, checkPendingExits } from '../engine/exits';
import { checkPendingEntries } from '../engine/entry';
import { syncTradierSnapshot } from '../tradier/syncTradierSnapshot';
import { trackOpenOrdersFromTradier } from '../engine/trackOpenOrders';
import { TradierClient } from '../broker/tradierClient';
import { computeSpreadPositionSnapshot } from '../core/positions';
import { markTradeClosedWithReason } from '../engine/lifecycle';
import { recordTradeClosed } from '../core/risk';

/**
 * Run monitor cycle
 * 
 * Per system-interfaces.md:
 * export async function runMonitorCycle(env: Env, now: Date): Promise<void>;
 */
export async function runMonitorCycle(env: Env, now: Date): Promise<void> {
  // Generate unique run ID for this monitor cycle
  const runId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  console.log('[monitor][start]', JSON.stringify({
    runId,
    timestamp: now.toISOString(),
  }));
  
  console.log('[monitor] cycle_start', {
    now: now.toISOString(),
  });

  // 0. Sync from Tradier (source of truth) - per Tradier-first spec
  // NOTE: Syncs run even outside market hours to keep data fresh
  // This ensures we always work from current broker state before monitoring exits
  // Master sync from Tradier (source of truth)
  // Fetches account, balances, positions, and orders in a single coherent snapshot
  let syncResult;
  
  try {
    syncResult = await syncTradierSnapshot(env);
    
    // Log sync results
    if (!syncResult.success) {
      console.error('[monitorCycle][sync][fatal] master sync failed', JSON.stringify({
        runId,
        errors: syncResult.errors,
        warnings: syncResult.warnings,
        note: 'Master sync failed - monitor cycle will continue but may have stale data',
      }));
    } else if (syncResult.warnings.length > 0) {
      console.warn('[monitorCycle][sync][warnings] master sync had non-fatal issues', JSON.stringify({
        runId,
        warnings: syncResult.warnings,
        snapshotId: syncResult.snapshot?.snapshotId,
        positions: syncResult.snapshot?.counts.positions,
        orders: syncResult.snapshot?.counts.orders,
        note: 'Continuing with monitor cycle - these are typically data oddities, not fatal failures',
      }));
    } else {
      console.log('[monitorCycle][sync][success]', JSON.stringify({
        runId,
        snapshotId: syncResult.snapshot?.snapshotId,
        positions: syncResult.snapshot?.counts.positions,
        orders: syncResult.snapshot?.counts.orders,
        balances: syncResult.snapshot?.balances,
      }));
    }
    
    // 1.3.5. Actively track all open orders from Tradier using Order API
    // This ensures we're using Tradier's order API to monitor order status in real-time
    await trackOpenOrdersFromTradier(env, now);
    
    console.log('[monitorCycle] all syncs completed', JSON.stringify({
      runId,
      snapshotId: syncResult.snapshot?.snapshotId,
      positions_synced: syncResult.snapshot?.counts.positions || 0,
      orders_synced: syncResult.snapshot?.counts.orders || 0,
      balances_synced: syncResult.snapshot?.balances !== null,
      warnings: syncResult.warnings.length,
      errors: syncResult.errors.length,
    }));
  } catch (error) {
    // Fatal sync failure (e.g., Tradier API down, auth issues, balances sync failed)
    // Abort cycle - cannot proceed without fresh Tradier data
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[monitorCycle][sync][fatal] unable to refresh from Tradier; skipping monitor cycle', JSON.stringify({
      runId,
      error: errorMsg,
    }));
    // Do NOT set LAST_MONITOR_RUN - no monitoring actually ran
    // Instead, track the error separately
    await setSetting(env, 'LAST_MONITOR_ERROR', now.toISOString()).catch(() => {});
    return; // Abort - cannot proceed without fresh Tradier data
  }
  
  // Note: master sync handles all sync operations (positions, orders, balances)
  // If sync failed, we already logged it above
  if (!syncResult.success) {
    console.warn('[monitorCycle] master sync had issues', JSON.stringify({
      success: syncResult.success,
      errors: syncResult.errors.length,
      warnings: syncResult.warnings.length,
      snapshotId: syncResult.snapshot?.snapshotId,
    }));
  }
  
  // 1.5. Repair portfolio: check structural integrity and close broken spreads
  const { repairPortfolio } = await import('../engine/monitoring');
  await repairPortfolio(env, now);
  
  // 1.6. Close trades that are marked OPEN but don't exist in Tradier
  await closePhantomTrades(env, runId, now);
  
  // 1.7. Sync trade quantities from portfolio positions
  // This ensures trade.quantity matches actual portfolio positions
  // (Exits use portfolio positions directly, but keeping trade.quantity in sync is useful for reporting)
  await syncTradeQuantitiesFromPortfolio(env, runId);
  
  // 2. Get all trades to monitor (after sync, so we have latest)
  const openTrades = await getOpenTrades(env);
  const pendingEntries = await getTradesByStatus(env, 'ENTRY_PENDING');
  const pendingExits = await getTradesByStatus(env, 'CLOSING_PENDING');
  
  // DEBUG: Check for trade 134 specifically
  const trade134 = openTrades.find(t => t.id === '134') || pendingExits.find(t => t.id === '134');
  if (trade134) {
    console.log('[monitor][debug][trade-134]', JSON.stringify({
      runId,
      trade_id: trade134.id,
      symbol: trade134.symbol,
      status: trade134.status,
      entry_price: trade134.entry_price,
      exit_price: trade134.exit_price,
      broker_order_id_open: trade134.broker_order_id_open,
      broker_order_id_close: trade134.broker_order_id_close,
      exit_reason: trade134.exit_reason,
      in_open_trades: openTrades.some(t => t.id === '134'),
      in_pending_exits: pendingExits.some(t => t.id === '134'),
      timestamp: now.toISOString(),
    }));
  }
  
   console.log('[monitor] open_trades_scan', JSON.stringify({
    runId,
    now: now.toISOString(),
    count: openTrades.length,
  }));

  // Early exit: Check if we have anything to monitor
  // Still update heartbeat even if nothing to monitor (for dashboard visibility)
  if (openTrades.length === 0 && pendingEntries.length === 0 && pendingExits.length === 0) {
    await setSetting(env, 'LAST_MONITOR_RUN', now.toISOString()).catch(() => {});
    return;
  }
  
  // 3. Check pending entries (double-check after order sync)
  await checkPendingEntries(env, now);
  
  // 4. Check pending exits (double-check after order sync)
  console.log('[monitorCycle] calling checkPendingExits', JSON.stringify({
    runId,
    pending_exits_count: pendingExits.length,
    pending_exit_trade_ids: pendingExits.map(t => t.id),
    timestamp: now.toISOString(),
  }));
  await checkPendingExits(env, now);
  
  // 5. Monitor all OPEN trades
  // PORTFOLIO-FIRST MONITORING:
  // - Portfolio sync runs first (line 48) to update portfolio_positions
  // - Monitoring uses trade.entry_price (from database) for PnL calculations
  // - Monitoring fetches current quotes from Tradier (portfolio_positions doesn't store bid/ask)
  // - Exits use portfolio_positions for quantities (via computeAvailableQuantities in exits.ts)
  for (const trade of openTrades) {
    // Only monitor OPEN trades (not ENTRY_PENDING or CLOSING_PENDING)
    if (trade.status !== 'OPEN') {
      continue;
    }
    
    // CRITICAL: Skip trades that were never actually opened (phantom trades)
    // All trades are opened by the system/gekkoworks, so they should have broker_order_id_open.
    // However, we also check entry_price as a safety net in case order ID wasn't set yet.
    // If trade has no entry_price AND no broker_order_id_open, it was never opened.
    const hasEvidenceOfEntry = (trade.entry_price && trade.entry_price > 0) || trade.broker_order_id_open;
    if (!hasEvidenceOfEntry) {
      console.error('[monitor][phantom-trade][skipping]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        status: trade.status,
        entry_price: trade.entry_price,
        broker_order_id_open: trade.broker_order_id_open,
        timestamp: now.toISOString(),
        note: 'Trade marked as OPEN but never actually opened - marking as error and skipping monitoring',
      }));
      
      // Mark as error instead of trying to monitor/close
      await updateTrade(env, trade.id, {
        status: 'EXIT_ERROR',
        exit_reason: 'PHANTOM_TRADE',
      });
      
      continue; // Skip this trade
    }
    
    try {
      // Log each trade being evaluated
      // NOTE: entry_price comes from trade (source of truth), not from orders or portfolio
      console.log('[monitor][trade]', JSON.stringify({
        id: trade.id,
        symbol: trade.symbol,
        expiration: trade.expiration,
        status: trade.status,
        entry_price: trade.entry_price, // From trade (source of truth for entry pricing)
        broker_order_id_open: trade.broker_order_id_open,
        timestamp: now.toISOString(),
      }));
      
      // Evaluate trade (uses trade.entry_price for PnL, fetches current quotes from Tradier)
      // PnL = entry_price (from trade) vs current_mark (from Tradier quotes)
      const decision = await evaluateOpenTrade(env, trade, now);
      
      // DEBUG: Log decision for trade 134
      if (trade.id === '134') {
        console.log('[monitor][debug][trade-134][decision]', JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          trigger: decision.trigger,
          pnl_fraction: decision.metrics.pnl_fraction,
          loss_fraction: decision.metrics.loss_fraction,
          current_mark: decision.metrics.current_mark,
          dte: decision.metrics.dte,
          underlying_price: decision.metrics.underlying_price,
          timestamp: now.toISOString(),
        }));
      }
      
      // If exit trigger fired, execute exit immediately (synchronous path)
      if (decision.trigger !== 'NONE') {
        console.log('[monitor][exit-signal]', JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          trigger: decision.trigger,
          pnl_fraction: decision.metrics.pnl_fraction,
          dte: decision.metrics.dte,
          timestamp: now.toISOString(),
        }));
        
        const exitResult = await executeExitForTrade(env, trade, decision, now);
        
        if (exitResult.success) {
          console.log('[exit][order][sent]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            trigger: decision.trigger,
            timestamp: now.toISOString(),
          }));
        } else {
          console.error('[exit][error]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            trigger: decision.trigger,
            reason: exitResult.reason,
            timestamp: now.toISOString(),
          }));
        }
      }
    } catch (error) {
      // Error evaluating trade - treat as emergency
      console.error('[monitor][error]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: now.toISOString(),
      }));
      const emergencyDecision = {
        trigger: 'EMERGENCY' as const,
        metrics: {
          current_mark: trade.entry_price || 0,
          unrealized_pnl: 0,
          pnl_fraction: 0,
          loss_fraction: 0,
          dte: 0,
          underlying_price: 0,
          underlying_change_1m: 0,
          underlying_change_15s: 0,
          liquidity_ok: false,
          quote_integrity_ok: false,
        },
      };
      
      await executeExitForTrade(env, trade, emergencyDecision, now);
    }
  }
  
  // Track last successful run
  await setSetting(env, 'LAST_MONITOR_RUN', now.toISOString()).catch(() => {});
}

/**
 * Close trades that are marked as OPEN but don't actually exist in Tradier
 * This handles cases where:
 * - A trade was marked OPEN but the position was closed outside our system
 * - An orphaned trade was created but never actually existed
 * 
 * Supports all strategy types (puts and calls) by including both in tradierPositions.
 */
async function closePhantomTrades(env: Env, runId: string, now: Date): Promise<void> {
  try {
    const broker = new TradierClient(env);
    // Get OPEN trades - getOpenTrades only returns status='OPEN' and managed=1
    const openTrades = await getOpenTrades(env);
    
    // Also get pending trades to check for stale entries/exits
    const pendingEntries = await getTradesByStatus(env, 'ENTRY_PENDING');
    const pendingExits = await getTradesByStatus(env, 'CLOSING_PENDING');
    
    // Combine all trades that need checking
    const tradesToCheck = [...openTrades, ...pendingEntries, ...pendingExits];
    
    if (tradesToCheck.length === 0) {
      return; // Nothing to check
    }
    
    console.log('[monitorCycle] checking trades against portfolio_positions', JSON.stringify({
      runId,
      totalTradesToCheck: tradesToCheck.length,
      openTrades: openTrades.length,
      pendingEntries: pendingEntries.length,
      pendingExits: pendingExits.length,
    }));
    
    // Check each OPEN trade using portfolio_positions
    for (const trade of openTrades) {
      // Only check managed trades
      if (trade.managed === 0) {
        continue;
      }
      
      // Determine option type from strategy
      if (!trade.strategy) {
        console.warn('[monitorCycle] trade missing strategy, skipping phantom check', JSON.stringify({
          tradeId: trade.id,
          symbol: trade.symbol,
        }));
        continue;
      }
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      
      // Get spread leg positions from portfolio_positions
      const { shortLeg, longLeg } = await getSpreadLegPositions(
        env,
        trade.symbol,
        trade.expiration,
        optionType,
        trade.short_strike,
        trade.long_strike
      );
      
      // Compute snapshot
      const snapshot = computeSpreadPositionSnapshot(trade, shortLeg, longLeg);
      
      // Rule A: Fully flat at broker (both legs zero)
      // CRITICAL: Only close if we have a close order ID (meaning we drove the close)
      // If positions are flat without a close order, something is wrong - investigate instead of auto-closing
      if (snapshot.shortQty === 0 && snapshot.longQty === 0) {
        // Check if we have a close order - if so, the order sync should have captured exit_price
        if (trade.broker_order_id_close) {
          // We have a close order - order sync should handle exit_price
          // But if it's still missing, this is a sync issue
          console.log('[monitor][phantom-close][has-close-order]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            broker_order_id_close: trade.broker_order_id_close,
            exit_price: trade.exit_price,
            reason: 'BROKER_ALREADY_FLAT',
            note: 'Position flat and close order exists - order sync should capture exit_price',
          }));
          
          // Don't auto-close here - let order sync handle it
          // If exit_price is still null after order sync, that's a separate issue
          continue;
        } else {
          // No close order but positions are flat - this shouldn't happen if we're managing
          // Log as warning but don't auto-close - needs investigation
          console.warn('[monitor][phantom-close][no-close-order]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            reason: 'BROKER_ALREADY_FLAT',
            note: 'WARNING: Position flat but no close order - position may have been closed externally or portfolio sync is wrong',
            recommendation: 'Investigate - do not auto-close',
          }));
          
          // Don't auto-close - leave trade OPEN for investigation
          continue;
        }
      }
      
      // Rule B: Legs out of sync (one leg has qty > 0, other is 0)
      if ((snapshot.shortQty === 0 && snapshot.longQty > 0) || (snapshot.shortQty > 0 && snapshot.longQty === 0)) {
        console.warn('[monitorCycle][legs-out-of-sync]', JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          expiration: trade.expiration,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          snapshot: {
            shortQty: snapshot.shortQty,
            longQty: snapshot.longQty,
          },
          note: 'One leg missing - manual investigation required. Trade left OPEN.',
        }));
        // Do not auto-close or auto-exit - leave trade as OPEN for manual investigation
        continue;
      }
      
      // Rule C: Normal case (both legs have qty > 0) - do nothing, monitoring continues as usual
    }
    
    // Check pending trades (ENTRY_PENDING, CLOSING_PENDING) - keep existing logic for now
    // These still need broker order checks, not just position checks
    for (const trade of [...pendingEntries, ...pendingExits]) {
      let shouldClose = false;
      let closeReason = '';
      
      if (trade.status === 'ENTRY_PENDING') {
        // For pending entries, check if order exists and is valid
        if (trade.broker_order_id_open) {
          try {
            const order = await broker.getOrder(trade.broker_order_id_open);
            // If order is rejected, cancelled, or expired, close the trade
            if (order.status === 'REJECTED' || order.status === 'CANCELLED' || order.status === 'EXPIRED') {
              shouldClose = true;
              closeReason = `ENTRY_ORDER_${order.status}`;
            }
          } catch (error) {
            // Order doesn't exist - mark as stale
            shouldClose = true;
            closeReason = 'ENTRY_PENDING_ORDER_NOT_FOUND';
          }
        } else {
          // No broker order ID - check age to avoid racing new entries
          // Only mark as phantom if trade is older than 5 minutes to avoid closing
          // trades that were just created but order ID hasn't been set yet
          const tradeAge = now.getTime() - new Date(trade.created_at || trade.opened_at || now.toISOString()).getTime();
          const MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes
          
          if (tradeAge >= MIN_AGE_MS) {
            shouldClose = true;
            closeReason = 'ENTRY_PENDING_NO_ORDER_ID';
          } else {
            // Too new - might be in the process of being created, skip for now
            console.log('[monitorCycle] skipping new ENTRY_PENDING trade without order ID', JSON.stringify({
              tradeId: trade.id,
              age_ms: tradeAge,
              min_age_ms: MIN_AGE_MS,
            }));
          }
        }
      } else if (trade.status === 'CLOSING_PENDING') {
        // For pending exits, check if order exists
        if (trade.broker_order_id_close) {
          try {
            const order = await broker.getOrder(trade.broker_order_id_close);
            if (order.status === 'REJECTED' || order.status === 'CANCELLED' || order.status === 'EXPIRED') {
              shouldClose = true;
              closeReason = `EXIT_ORDER_${order.status}`;
            }
          } catch (error) {
            // Order doesn't exist - mark as stale
            shouldClose = true;
            closeReason = 'CLOSING_PENDING_ORDER_NOT_FOUND';
          }
        } else {
          // No broker order ID - check age to avoid racing new exits
          // Only mark as stale if trade is older than 5 minutes
          const tradeAge = now.getTime() - new Date(trade.created_at || trade.opened_at || now.toISOString()).getTime();
          const MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes
          
          if (tradeAge >= MIN_AGE_MS) {
            // Trade is old enough and has no order ID - mark as stale
            shouldClose = true;
            closeReason = 'CLOSING_PENDING_NO_ORDER_ID';
          } else {
            // Too new - might be in the process of being created, skip for now
            console.log('[monitorCycle] skipping new CLOSING_PENDING trade without order ID', JSON.stringify({
              tradeId: trade.id,
              age_ms: tradeAge,
              min_age_ms: MIN_AGE_MS,
            }));
          }
        }
      }
      
      if (shouldClose) {
        // CRITICAL: Check if trade was actually opened before closing
        // All trades are opened by the system/gekkoworks, so they should have broker_order_id_open.
        // However, we also check entry_price as a safety net in case order ID wasn't set yet.
        // If trade has no entry_price AND no broker_order_id_open, it's a phantom trade.
        const hasEvidenceOfEntry = (trade.entry_price && trade.entry_price > 0) || trade.broker_order_id_open;
        
        if (!hasEvidenceOfEntry) {
          // Phantom trade - never actually opened, mark as error
          console.error('[monitorCycle] phantom trade detected (never opened)', JSON.stringify({
            tradeId: trade.id,
            status: trade.status,
            symbol: trade.symbol,
            strategy: trade.strategy,
            expiration: trade.expiration,
            short_strike: trade.short_strike,
            long_strike: trade.long_strike,
            entry_price: trade.entry_price,
            broker_order_id_open: trade.broker_order_id_open,
            reason: closeReason,
            note: 'Trade marked as OPEN but never actually opened - marking as error instead of closing',
          }));
          
          await updateTrade(env, trade.id, {
            status: 'EXIT_ERROR',
            exit_reason: 'PHANTOM_TRADE',
          });
          
          continue; // Skip to next trade
        }
        
        // Trade was opened but positions don't exist - this is a legitimate "already flat" scenario
        console.log('[monitorCycle] closing phantom/stale trade (was opened)', JSON.stringify({
          tradeId: trade.id,
          status: trade.status,
          symbol: trade.symbol,
          expiration: trade.expiration,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          broker_order_id_open: trade.broker_order_id_open,
          broker_order_id_close: trade.broker_order_id_close,
          entry_price: trade.entry_price,
          reason: closeReason,
          note: 'Trade was opened but positions no longer exist - closing as already flat',
        }));
        
        // Determine final status based on original status and reason
        if (trade.status === 'OPEN' || closeReason.includes('POSITION_NOT_FOUND')) {
          // Was open but position doesn't exist - mark as closed
          // Use MANUAL_CLOSE exit_reason to indicate this was closed outside our system
          // Don't assume full loss - use neutral/null PnL to keep data hygiene separate from financial result
          const updated = await updateTrade(env, trade.id, {
            status: 'CLOSED',
            exit_reason: 'MANUAL_CLOSE', // Indicates position was closed outside our system (phantom reconciliation)
            closed_at: new Date().toISOString(),
            exit_price: null, // We don't know the actual exit price
            realized_pnl: null, // Leave PnL null - reconcile manually if needed, don't assume full loss
          });
          
          // Record in risk stats (with null PnL) for consistency
          await recordTradeClosed(env, updated);
        } else {
          // Was pending but order failed - mark as cancelled
          await updateTrade(env, trade.id, {
            status: 'CANCELLED',
            exit_reason: 'UNKNOWN',
          });
        }
      }
    }
  } catch (error) {
    console.error('[monitorCycle] error closing phantom trades', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    // Don't throw - this is a cleanup operation, shouldn't block monitoring
  }
}

/**
 * Sync trade quantities from portfolio positions
 * This keeps trade.quantity in sync with actual portfolio positions
 * Note: Exits use portfolio positions directly, but keeping trade.quantity accurate is useful for reporting
 */
async function syncTradeQuantitiesFromPortfolio(env: Env, runId: string): Promise<void> {
  try {
    const openTrades = await getOpenTrades(env);
    let syncedCount = 0;
    
    for (const trade of openTrades) {
      if (!trade.strategy) {
        continue; // Skip trades without strategy
      }
      
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      
      // Get spread leg positions from portfolio
      const { shortLeg, longLeg } = await getSpreadLegPositions(
        env,
        trade.symbol,
        trade.expiration,
        optionType,
        trade.short_strike,
        trade.long_strike
      );
      
      // Compute snapshot to get actual quantities
      const snapshot = computeSpreadPositionSnapshot(trade, shortLeg, longLeg);
      
      // Portfolio quantity is the minimum of short and long legs (spread quantity)
      const portfolioQuantity = Math.min(snapshot.shortQty, snapshot.longQty);
      
      // Only update if there's a mismatch and portfolio quantity is valid
      if (trade.quantity !== portfolioQuantity && portfolioQuantity > 0) {
        // Update trade quantity to match portfolio
        // Also update max_profit and max_loss proportionally
        const perContractMaxProfit = trade.max_profit && trade.quantity > 0
          ? trade.max_profit / trade.quantity
          : null;
        const perContractMaxLoss = trade.max_loss && trade.quantity > 0
          ? trade.max_loss / trade.quantity
          : null;
        
        await updateTrade(env, trade.id, {
          quantity: portfolioQuantity,
          max_profit: perContractMaxProfit !== null
            ? perContractMaxProfit * portfolioQuantity
            : trade.max_profit,
          max_loss: perContractMaxLoss !== null
            ? perContractMaxLoss * portfolioQuantity
            : trade.max_loss,
        });
        
        syncedCount++;
        
        console.log('[monitorCycle][sync-quantities]', JSON.stringify({
          runId,
          trade_id: trade.id,
          symbol: trade.symbol,
          old_quantity: trade.quantity,
          new_quantity: portfolioQuantity,
          short_leg_qty: snapshot.shortQty,
          long_leg_qty: snapshot.longQty,
        }));
      }
    }
    
    if (syncedCount > 0) {
      console.log('[monitorCycle][sync-quantities-summary]', JSON.stringify({
        runId,
        trades_synced: syncedCount,
        total_trades_checked: openTrades.length,
      }));
    }
  } catch (error) {
    // Non-fatal - log but don't abort monitor cycle
    console.warn('[monitorCycle][sync-quantities-error]', JSON.stringify({
      runId,
      error: error instanceof Error ? error.message : String(error),
      note: 'Trade quantity sync failed - continuing with monitor cycle',
    }));
  }
}

