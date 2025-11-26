/**
 * SAS v1 Monitor Cycle
 * 
 * Runs frequently to monitor open trades and execute exits.
 * Per architecture.md and monitoring.md.
 */

import type { Env } from '../env';
import { getOpenTrades, getTradesByStatus, updateTrade, setSetting } from '../db/queries';
import { evaluateOpenTrade } from '../engine/monitoring';
import { executeExitForTrade, checkPendingExits } from '../engine/exits';
import { checkPendingEntries } from '../engine/entry';
import { syncPortfolioFromTradier, parseOptionSymbol } from '../engine/portfolioSync';
import { syncOrdersFromTradier } from '../engine/orderSync';
import { syncBalancesFromTradier } from '../engine/balancesSync';
import { TradierClient } from '../broker/tradierClient';

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
  let positionsSyncResult;
  let ordersSyncResult;
  let balancesSyncResult;
  
  try {
    positionsSyncResult = await syncPortfolioFromTradier(env);
    // Portfolio sync errors are typically non-fatal (e.g., "options not found in chain")
    // Only abort if sync completely failed (caught in outer catch)
    if (positionsSyncResult.errors.length > 0) {
      console.warn('[monitorCycle][sync][warnings] positions sync had non-fatal issues', JSON.stringify({
        runId,
        errors: positionsSyncResult.errors,
        synced: positionsSyncResult.synced,
        note: 'Continuing with sync - these are typically data oddities, not fatal failures',
      }));
    }
    
    ordersSyncResult = await syncOrdersFromTradier(env);
    // Order sync errors are typically non-fatal (e.g., individual order sync failures)
    // Only abort if sync completely failed (caught in outer catch)
    if (ordersSyncResult.errors.length > 0) {
      console.warn('[monitorCycle][sync][warnings] orders sync had non-fatal issues', JSON.stringify({
        runId,
        errors: ordersSyncResult.errors,
        synced: ordersSyncResult.synced,
        note: 'Continuing with sync - these are typically individual order issues, not fatal failures',
      }));
    }
    
    balancesSyncResult = await syncBalancesFromTradier(env);
    // Balances sync is important for risk calculations, but for exits we can continue
    // with warnings if positions/orders sync succeeded. This allows exits to fire even
    // during balances API outages, which is the correct failure mode for exit logic.
    if (!balancesSyncResult.success) {
      console.warn('[monitorCycle][sync][warnings] balances sync failed, continuing with exits', JSON.stringify({
        runId,
        errors: balancesSyncResult.errors,
        note: 'Exits can proceed without balances - risk calculations may be stale but exits should still fire',
      }));
      // Continue anyway - exits don't strictly need balances, only positions/orders
    }
    
    console.log('[monitorCycle] all syncs completed', JSON.stringify({
      runId,
      positions_synced: positionsSyncResult.synced,
      positions_warnings: positionsSyncResult.errors.length,
      orders_synced: ordersSyncResult.synced,
      orders_warnings: ordersSyncResult.errors.length,
      balances_success: balancesSyncResult.success,
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
  
  if (positionsSyncResult.created > 0) {
    console.log('[monitorCycle] portfolio sync created trades', JSON.stringify({
      created: positionsSyncResult.created,
    }));
  }
  
  // 1.5. Repair portfolio: check structural integrity and close broken spreads
  const { repairPortfolio } = await import('../engine/monitoring');
  await repairPortfolio(env, now);
  
  // 1.6. Close trades that are marked OPEN but don't exist in Tradier
  await closePhantomTrades(env, runId, now);
  
  // 2. Get all trades to monitor (after sync, so we have latest)
  const openTrades = await getOpenTrades(env);
  const pendingEntries = await getTradesByStatus(env, 'ENTRY_PENDING');
  const pendingExits = await getTradesByStatus(env, 'CLOSING_PENDING');
  
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
  await checkPendingExits(env, now);
  
  // 5. Monitor all OPEN trades
  for (const trade of openTrades) {
    // Only monitor OPEN trades (not ENTRY_PENDING or CLOSING_PENDING)
    if (trade.status !== 'OPEN') {
      continue;
    }
    
    try {
      // Log each trade being evaluated
      console.log('[monitor][trade]', JSON.stringify({
        id: trade.id,
        symbol: trade.symbol,
        expiration: trade.expiration,
        status: trade.status,
        entry_price: trade.entry_price,
        timestamp: now.toISOString(),
      }));
      
      // Evaluate trade (always uses fresh quotes from Tradier)
      const decision = await evaluateOpenTrade(env, trade, now);
      
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
    // Get OPEN trades - getOpenTrades only returns status='OPEN'
    const openTrades = await getOpenTrades(env);
    
    // Also get pending trades to check for stale entries/exits
    const pendingEntries = await getTradesByStatus(env, 'ENTRY_PENDING');
    const pendingExits = await getTradesByStatus(env, 'CLOSING_PENDING');
    
    // Combine all trades that need checking
    const tradesToCheck = [...openTrades, ...pendingEntries, ...pendingExits];
    
    if (tradesToCheck.length === 0) {
      return; // Nothing to check
    }
    
    // Get all positions from Tradier
    const positions = await broker.getPositions();
    
    // Create a set of position identifiers (symbol + expiration + strike)
    // Include both puts and calls to support all strategy types (BULL_PUT_CREDIT, BEAR_CALL_CREDIT, etc.)
    const tradierPositions = new Set<string>();
    for (const pos of positions) {
      // Reuse parseOptionSymbol from portfolioSync to avoid duplicating regex logic
      const parsed = parseOptionSymbol(pos.symbol);
      if (parsed) {
        // Add position key for both puts and calls
        tradierPositions.add(`${parsed.underlying}-${parsed.expiration}-${parsed.strike}`);
      }
    }
    
    console.log('[monitorCycle] checking trades against Tradier positions', JSON.stringify({
      runId,
      totalTradesToCheck: tradesToCheck.length,
      openTrades: openTrades.length,
      pendingEntries: pendingEntries.length,
      pendingExits: pendingExits.length,
      tradierPositionCount: positions.length,
      tradierPositionKeys: Array.from(tradierPositions),
    }));
    
    // Check each trade (OPEN, ENTRY_PENDING, CLOSING_PENDING)
    for (const trade of tradesToCheck) {
      let shouldClose = false;
      let closeReason = '';
      
      if (trade.status === 'OPEN') {
        // Check if both legs exist in Tradier
        const shortKey = `${trade.symbol}-${trade.expiration}-${trade.short_strike}`;
        const longKey = `${trade.symbol}-${trade.expiration}-${trade.long_strike}`;
        
        const shortExists = tradierPositions.has(shortKey);
        const longExists = tradierPositions.has(longKey);
        
        // If neither leg exists, the trade is phantom
        if (!shortExists && !longExists) {
          shouldClose = true;
          closeReason = 'PHANTOM_POSITION_CLOSED';
        }
      } else if (trade.status === 'ENTRY_PENDING') {
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
            // Order doesn't exist - check if position exists (maybe it filled but we didn't update)
            const shortKey = `${trade.symbol}-${trade.expiration}-${trade.short_strike}`;
            const longKey = `${trade.symbol}-${trade.expiration}-${trade.long_strike}`;
            const shortExists = tradierPositions.has(shortKey);
            const longExists = tradierPositions.has(longKey);
            
            // If position doesn't exist either, it's phantom
            if (!shortExists && !longExists) {
              shouldClose = true;
              closeReason = 'ENTRY_PENDING_ORDER_NOT_FOUND';
            }
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
            // Order doesn't exist - check if position still exists
            const shortKey = `${trade.symbol}-${trade.expiration}-${trade.short_strike}`;
            const longKey = `${trade.symbol}-${trade.expiration}-${trade.long_strike}`;
            const shortExists = tradierPositions.has(shortKey);
            const longExists = tradierPositions.has(longKey);
            
            // If position doesn't exist, it was likely closed outside our system
            if (!shortExists && !longExists) {
              shouldClose = true;
              closeReason = 'CLOSING_PENDING_POSITION_NOT_FOUND';
            }
          }
        } else {
          // No broker order ID - check age to avoid racing new exits
          // Only mark as stale if trade is older than 5 minutes
          const tradeAge = now.getTime() - new Date(trade.created_at || trade.opened_at || now.toISOString()).getTime();
          const MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes
          
          if (tradeAge >= MIN_AGE_MS) {
            // Check if position still exists - if not, it was closed outside our system
            const shortKey = `${trade.symbol}-${trade.expiration}-${trade.short_strike}`;
            const longKey = `${trade.symbol}-${trade.expiration}-${trade.long_strike}`;
            const shortExists = tradierPositions.has(shortKey);
            const longExists = tradierPositions.has(longKey);
            
            if (!shortExists && !longExists) {
              shouldClose = true;
              closeReason = 'CLOSING_PENDING_NO_ORDER_ID_POSITION_NOT_FOUND';
            }
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
        console.log('[monitorCycle] closing phantom/stale trade', JSON.stringify({
          tradeId: trade.id,
          status: trade.status,
          symbol: trade.symbol,
          expiration: trade.expiration,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          broker_order_id_open: trade.broker_order_id_open,
          broker_order_id_close: trade.broker_order_id_close,
          reason: closeReason,
        }));
        
        // Determine final status based on original status and reason
        if (trade.status === 'OPEN' || closeReason.includes('POSITION_NOT_FOUND')) {
          // Was open but position doesn't exist - mark as closed
          // Use MANUAL_CLOSE exit_reason to indicate this was closed outside our system
          // Don't assume full loss - use neutral/null PnL to keep data hygiene separate from financial result
          await updateTrade(env, trade.id, {
            status: 'CLOSED',
            exit_reason: 'MANUAL_CLOSE', // Indicates position was closed outside our system (phantom reconciliation)
            closed_at: new Date().toISOString(),
            realized_pnl: null, // Leave PnL null - reconcile manually if needed, don't assume full loss
          });
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

