/**
 * SAS v1 Exit Engine
 * 
 * Implements exit-rules.md exactly.
 * 
 * Responsibilities:
 * - Execute exits based on monitoring decisions
 * - Compute closing limit prices
 * - Place closing orders
 * - Poll for fills
 * - Update trade state
 */

import type { Env } from '../env';
import type {
  TradeRow,
  ExitExecutionResult,
  ExitTriggerType,
  ExitReason,
  MonitoringDecision,
  BrokerOrder,
  SpreadLeg,
} from '../types';
import { TradierClient } from '../broker/tradierClient';
import { markTradeClosingPending, markTradeClosed, markTradeClosedWithReason, markTradeCancelled } from './lifecycle';
import { recordTradeClosed, incrementEmergencyExitCount } from '../core/risk';
import { getTradingMode, getDefaultTradeQuantity } from '../core/config';
import { notifyExitSubmitted } from '../notifications/telegram';
import { updateTrade, getSpreadLegPositions } from '../db/queries';
import { computeSpreadPositionSnapshot } from '../core/positions';
import { getOpenPositionsForTrade } from '../portfolio/getOpenPositionsForTrade';
import { buildExitOrderPayload, type ExitOrderPayload } from '../tradier/buildExitOrderPayload';
import { placeMarketExitOrder } from './placeMarketExitOrder';

// WIDENED SLIPPAGE: More aggressive limits to ensure quick fills
// Initial exit: 0.10 (was 0.02) - more aggressive to get fills quickly
// Retry exit: 0.20 (was 0.03) - even more aggressive on retry
// Final emergency: max_loss + 0.30 (was 0.20) - last resort before market order
const CLOSE_SLIPPAGE = 0.10; // Increased from 0.02 for faster fills
const CLOSE_RETRY_SLIPPAGE = 0.20; // Increased from 0.03 for retry attempts
const CLOSE_EMERGENCY_SLIPPAGE = 0.30; // Increased from 0.20 for final emergency
const MAX_FILL_WAIT_MS = 20 * 1000; // 20 seconds
const POLL_INTERVAL_MS = 2 * 1000; // 2 seconds
const MARKET_LIKE_TIMEOUT_MS = 60 * 1000; // 60 seconds (1 minute) - after this, use market-like pricing to force fill

/**
 * Check if order rejection is due to quantity mismatch
 */
function isQuantityMismatchRejection(order: any): boolean {
  const reason = (order.reason_description || '').toLowerCase();
  const legReasons = (order.leg || [])
    .map((l: any) => (l.reason_description || '').toLowerCase())
    .join(' | ');
  const text = reason + ' ' + legReasons;
  return text.includes('more shares than your current short position') ||
         text.includes('more shares than your current long position') ||
         text.includes('current position quantity');
}

/**
 * Compute available quantities from portfolio_positions
 * Returns quantities that can actually be closed, accounting for open orders
 * 
 * PORTFOLIO-FIRST APPROACH:
 * - Quantities: From portfolio_positions (source of truth for position sizes)
 * - Entry prices: From trade.entry_price (stored at trade open)
 * - Current pricing: From decision.metrics.current_mark (from monitoring, which fetches Tradier quotes)
 * - PnL: Calculated in monitoring using entry_price vs current_mark
 */
async function computeAvailableQuantities(
  env: Env,
  broker: TradierClient,
  trade: TradeRow,
  shortOptionSymbol: string,
  longOptionSymbol: string,
  targetQuantity: number
): Promise<{
  shortQtyToClose: number;
  longQtyToClose: number;
  shortPosition: number;
  longPosition: number;
  shortQtyInOpenOrders: number;
  longQtyInOpenOrders: number;
}> {
  // Determine option type from strategy
  if (!trade.strategy) {
    throw new Error(`Trade ${trade.id} missing strategy - cannot determine option type`);
  }
  const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
  
  // Get positions from portfolio_positions (primary source)
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
  const shortPosQty = snapshot.shortQty;
  const longPosQty = snapshot.longQty;
  
  // Get open orders that might be closing these positions
  // (Still need broker for this - open orders aren't in portfolio_positions)
  const openOrders = await broker.getOpenOrders();
  
  // Find orders that are trying to close these specific options
  let shortQtyInOpenOrders = 0;
  let longQtyInOpenOrders = 0;
  
  for (const order of openOrders) {
    // For multileg orders, we need to check the order details
    if (order.status === 'OPEN' || order.status === 'NEW') {
      try {
        const orderDetails = await broker.getOrderWithLegs(order.id);
        const legs = orderDetails.leg || [];
        
        for (const leg of legs) {
          if (leg.option_symbol === shortOptionSymbol) {
            if (leg.side?.includes('buy_to_close')) {
              shortQtyInOpenOrders += leg.quantity || 0;
            }
          }
          if (leg.option_symbol === longOptionSymbol) {
            if (leg.side?.includes('sell_to_close')) {
              longQtyInOpenOrders += leg.quantity || 0;
            }
          }
        }
      } catch (err) {
        // If we can't get order details, skip it
        console.warn('[exit][computeQuantities] failed to get order details', {
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  
  // Available quantity = position - already pending in open orders
  const shortAvailable = Math.max(0, shortPosQty - shortQtyInOpenOrders);
  const longAvailable = Math.max(0, longPosQty - longQtyInOpenOrders);
  
  // Compute quantities to close (min of target and available)
  const shortQtyToClose = Math.min(targetQuantity, shortAvailable);
  const longQtyToClose = Math.min(targetQuantity, longAvailable);
  
  console.log('[exit][position-snapshot]', JSON.stringify({
    source: 'computeAvailableQuantities',
    trade_id: trade.id,
    symbol: trade.symbol,
    short_strike: trade.short_strike,
    long_strike: trade.long_strike,
    snapshot: {
      shortQty: snapshot.shortQty,
      longQty: snapshot.longQty,
    },
    shortQtyInOpenOrders,
    longQtyInOpenOrders,
    shortAvailable,
    longAvailable,
    shortQtyToClose,
    longQtyToClose,
  }));
  
  return {
    shortQtyToClose,
    longQtyToClose,
    shortPosition: shortPosQty,
    longPosition: longPosQty,
    shortQtyInOpenOrders,
    longQtyInOpenOrders,
  };
}

/**
 * Cancel any open close orders for the given option symbols
 */
async function cancelOpenCloseOrders(
  broker: TradierClient,
  shortOptionSymbol: string,
  longOptionSymbol: string
): Promise<number> {
  const openOrders = await broker.getOpenOrders();
  let cancelledCount = 0;
  
  for (const order of openOrders) {
    if (order.status === 'OPEN' || order.status === 'NEW') {
      try {
        const orderDetails = await broker.getOrderWithLegs(order.id);
        const orderClass = orderDetails.class || '';
        const legs = orderDetails.leg || [];
        
        // Check if this is a close order for our symbols
        let isCloseOrder = false;
        for (const leg of legs) {
          if ((leg.option_symbol === shortOptionSymbol || leg.option_symbol === longOptionSymbol) &&
              (leg.side?.includes('buy_to_close') || leg.side?.includes('sell_to_close'))) {
            isCloseOrder = true;
            break;
          }
        }
        
        // Also check single-leg option orders
        if (!isCloseOrder && orderClass === 'option') {
          const optionSymbol = orderDetails.option_symbol;
          const side = orderDetails.side || '';
          if ((optionSymbol === shortOptionSymbol || optionSymbol === longOptionSymbol) &&
              (side.includes('buy_to_close') || side.includes('sell_to_close'))) {
            isCloseOrder = true;
          }
        }
        
        if (isCloseOrder) {
          console.log('[exit][cancelOpenOrders] cancelling order', JSON.stringify({
            orderId: order.id,
            class: orderClass,
            status: order.status,
          }));
          
          await broker.cancelOrder(order.id);
          cancelledCount++;
        }
      } catch (err) {
        console.warn('[exit][cancelOpenOrders] failed to cancel order', {
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  
  if (cancelledCount > 0) {
    console.log('[exit][cancelOpenOrders] cancelled', JSON.stringify({
      count: cancelledCount,
      shortOptionSymbol,
      longOptionSymbol,
    }));
  }
  
  return cancelledCount;
}

/**
 * Calculate market-like limit price for exit orders
 * This is used when an order has been open too long and needs to be filled immediately
 * Market-like means: accept worst-case pricing to guarantee fill
 */
function calculateMarketLikeLimitPrice(
  trade: TradeRow,
  isDebitSpread: boolean
): number {
  // For market-like orders, we accept the worst-case scenario to guarantee fill
  if (isDebitSpread) {
    // Debit spread exit: we receive credit
    // Market-like: accept minimum credit (essentially 0.01, but use a small buffer)
    return 0.01;
  } else {
    // Credit spread exit: we pay debit
    // Market-like: accept maximum debit (essentially full width, but use entry_price as worst case)
    if (trade.entry_price && trade.entry_price > 0) {
      // Worst case: pay back the full credit we received, plus a buffer
      return trade.width; // Full width is the maximum we could pay
    } else {
      // Fallback: use full width
      return trade.width;
    }
  }
}

/**
 * Execute exit for a trade
 * 
 * Per system-interfaces.md:
 * export async function executeExitForTrade(
 *   env: Env,
 *   trade: TradeRow,
 *   decision: MonitoringDecision,
 *   now: Date
 * ): Promise<ExitExecutionResult>;
 */
export async function executeExitForTrade(
  env: Env,
  trade: TradeRow,
  decision: MonitoringDecision,
  now: Date
): Promise<ExitExecutionResult> {
  // PORTFOLIO-FIRST EXIT EXECUTION:
  // - Quantities: From portfolio_positions (via computeAvailableQuantities)
  // - Entry prices: From trade.entry_price (stored at trade open)
  // - Current pricing: From decision.metrics.current_mark (from monitoring, which fetches Tradier quotes)
  // - PnL: Already calculated in monitoring using entry_price vs current_mark
  
  // CRITICAL: EXITS BYPASS ALL CONCENTRATION LIMITS
  // Exit orders must ALWAYS be allowed to close positions, regardless of:
  // - MAX_SPREADS_PER_SYMBOL
  // - MAX_QTY_PER_SYMBOL_PER_SIDE
  // - MAX_TRADE_QUANTITY
  // - MAX_TOTAL_QTY_PER_SYMBOL
  // These limits only apply to ENTRY orders (checked in entry.ts), never to exits.
  // Exits are risk management actions and must execute immediately when triggered.
  // This function does NOT check any concentration limits - it only validates the exit trigger.
  
  if (decision.trigger === 'NONE') {
    return {
      trade,
      trigger: 'NONE',
      success: false,
      reason: 'No exit trigger',
    };
  }
  
  // Skip if trade is already in error state or closed
  if (trade.status === 'EXIT_ERROR' || trade.status === 'CLOSED') {
    return {
      trade,
      trigger: decision.trigger,
      success: false,
      reason: `Trade is ${trade.status}, skipping exit`,
    };
  }
  
  try {
    console.log('[exit][signal]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      trigger: decision.trigger,
      pnl_fraction: decision.metrics.pnl_fraction,
      current_mark: decision.metrics.current_mark,
      entry_price: trade.entry_price, // From trade (source of truth)
      dte: decision.metrics.dte,
      timestamp: now.toISOString(),
    }));
    
    const broker = new TradierClient(env);
    
    // Track exit attempts (simple approach: store in a JSON field or count)
    // For now, we'll check if broker_order_id_close exists to infer attempts
    // In a future version, we can add exit_attempt_count to schema
    const existingCloseOrderId = trade.broker_order_id_close;
    const hasPreviousAttempt = !!existingCloseOrderId;
    
    // If we've had multiple failed attempts, mark as error
    // We'll use a simple heuristic: if there's a close order ID but trade is still OPEN,
    // that suggests a previous attempt failed
    if (hasPreviousAttempt && trade.status === 'OPEN') {
      // Check how many times we've tried
      // For now, we'll mark as error if we see persistent failures
      // A more robust solution would track attempt count in DB
      console.warn('[exit][max-attempts-check]', JSON.stringify({
        trade_id: trade.id,
        has_previous_attempt: hasPreviousAttempt,
        current_status: trade.status,
        timestamp: now.toISOString(),
      }));
    }
    
    // Map exit trigger to exit reason
    const exitReason = mapTriggerToExitReason(decision.trigger);
    
    // Check trading mode
    const tradingMode = await getTradingMode(env);
    
    if (tradingMode === 'DRY_RUN') {
      // DRY_RUN mode - log but do not place order
      console.log(`[DRY_RUN] Would place market exit order:`, {
        trade_id: trade.id,
        trigger: decision.trigger,
        exit_reason: exitReason,
      });
      
      // In DRY_RUN, we don't actually close - just log
      return {
        trade,
        trigger: decision.trigger,
        success: false,
        reason: 'DRY_RUN mode - exit order not placed',
      };
    }
    
    // Get positions from portfolio_positions (source of truth)
    const positions = await getOpenPositionsForTrade(env, trade);
    
    if (positions.length === 0) {
      // No positions to close - check if already flat
      const closedTrade = await handleAlreadyFlat(
        env,
        broker,
        trade,
        decision,
        '', // Option symbols not needed for already flat check
        '',
        now
      );
      
      return {
        trade: closedTrade,
        trigger: decision.trigger,
        success: true,
      };
    }
    
    // Get option symbols for canceling existing orders
    if (!trade.strategy) {
      throw new Error(`Trade ${trade.id} missing strategy field - cannot determine option type for exit`);
    }
    const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
    const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
    const shortOption = optionChain.find(
      opt => opt.strike === trade.short_strike && opt.type === optionType
    );
    const longOption = optionChain.find(
      opt => opt.strike === trade.long_strike && opt.type === optionType
    );
    
    if (!shortOption || !longOption) {
      throw new Error(`Cannot find ${optionType} option legs for exit`);
    }
    
    // STEP 1: Cancel any existing open close orders for these positions
    const cancelledCount = await cancelOpenCloseOrders(
      broker,
      shortOption.symbol,
      longOption.symbol
    );
    
    if (cancelledCount > 0) {
      // Wait a moment for cancellations to process
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // STEP 2: Create exit proposal and order record for explicit linkage
    const { generateClientOrderId, createOrderRecord } = await import('./orderHelpers');
    const { insertProposal } = await import('../db/queries');
    // Create exit proposal linked to the trade
    const exitProposal = await insertProposal(env, {
      id: crypto.randomUUID(),
      symbol: trade.symbol,
      expiration: trade.expiration,
      short_strike: trade.short_strike,
      long_strike: trade.long_strike,
      width: trade.width,
      quantity: trade.quantity,
      strategy: trade.strategy || 'BULL_PUT_CREDIT',
      credit_target: 0, // Market orders don't have a target price
      score: 0, // Exit proposals don't need scoring
      ivr_score: 0,
      vertical_skew_score: 0,
      term_structure_score: 0,
      delta_fitness_score: 0,
      ev_score: 0,
      status: 'READY',
      kind: 'EXIT',
      linked_trade_id: trade.id,
    });
    
    // Generate client_order_id and create order record
    const clientOrderId = generateClientOrderId(exitProposal.id, 'EXIT');
    await createOrderRecord(env, exitProposal, 'EXIT', clientOrderId);
    
    // Place closing order (SANDBOX_PAPER or LIVE)
    let order: BrokerOrder;
    let primaryOrderId: string; // Declare outside try block for use after
    // Import once at the top of the function for reuse
    const { isBenignRejection } = await import('../core/systemMode');
    
    try {
      
      // NEW MARKET ORDER SYSTEM: Use portfolio_positions and place market orders
      // This replaces the old limit order system with market orders for reliable fills
      const marketOrderResult = await placeMarketExitOrder(env, trade, now);
      
      if (!marketOrderResult.success || marketOrderResult.orderIds.length === 0) {
        // Market order placement failed
        const errorReason = marketOrderResult.reason || 'Unknown error placing market exit order';
        console.error('[exit][market-order][failed]', JSON.stringify({
          trade_id: trade.id,
          reason: errorReason,
          timestamp: now.toISOString(),
        }));
        
        // Mark trade with error but don't close it - will retry on next cycle
        await updateTrade(env, trade.id, {
          status: 'EXIT_ERROR',
          exit_reason: exitReason,
        });
        
        return {
          trade: await import('../db/queries').then(m => m.getTrade(env, trade.id)) || trade,
          trigger: decision.trigger,
          success: false,
          reason: errorReason,
        };
      }
      
      // Use the first order ID as the primary close order ID
      // For per-leg orders, we track all of them but use the first as primary
      primaryOrderId = marketOrderResult.orderIds[0];
      order = {
        id: primaryOrderId,
        status: 'OPEN' as const,
        avg_fill_price: null,
        filled_quantity: 0,
        remaining_quantity: 0,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      
      // CRITICAL: Immediately sync order status from Tradier to catch fills/rejections
      try {
        const { syncSingleOrderFromTradier } = await import('./orderSyncNew');
        for (const orderId of marketOrderResult.orderIds) {
          await syncSingleOrderFromTradier(env, orderId, clientOrderId);
        }
      } catch (syncError) {
        console.warn('[exit][order][immediate-sync-error]', JSON.stringify({
          trade_id: trade.id,
          order_ids: marketOrderResult.orderIds,
          error: syncError instanceof Error ? syncError.message : String(syncError),
          note: 'Will be synced on next monitor cycle',
        }));
      }
      
      // Immediately check order status to catch any rejections
      try {
        const initialStatus = await broker.getOrder(primaryOrderId);
        
        console.log('[exit][market-order][initial-status]', JSON.stringify({
          trade_id: trade.id,
          order_id: primaryOrderId,
          all_order_ids: marketOrderResult.orderIds,
          status: initialStatus.status,
          filled_quantity: initialStatus.filled_quantity,
          remaining_quantity: initialStatus.remaining_quantity,
          avg_fill_price: initialStatus.avg_fill_price,
          timestamp: now.toISOString(),
        }));
        
        // If order was immediately rejected, log and mark for retry
        if (initialStatus.status === 'REJECTED' || initialStatus.status === 'CANCELLED') {
          console.error('[exit][market-order][rejected]', JSON.stringify({
              trade_id: trade.id,
            order_id: primaryOrderId,
              status: initialStatus.status,
            all_order_ids: marketOrderResult.orderIds,
            note: 'Market order rejected - will retry on next cycle',
              timestamp: now.toISOString(),
            }));
            
          // Mark trade with error but don't close it - will retry on next cycle
          await updateTrade(env, trade.id, {
            status: 'EXIT_ERROR',
            exit_reason: exitReason,
          });
          
          return {
            trade: await import('../db/queries').then(m => m.getTrade(env, trade.id)) || trade,
            trigger: decision.trigger,
            success: false,
            reason: `Market order rejected: ${initialStatus.status}`,
          };
        }
      } catch (statusError) {
        // Log but don't fail - we'll poll for status in pollForExitFill
        console.log('[exit][market-order][status-check-error]', JSON.stringify({
          trade_id: trade.id,
          order_id: primaryOrderId,
          error: statusError instanceof Error ? statusError.message : String(statusError),
          timestamp: now.toISOString(),
        }));
      }
    } catch (orderError) {
      // Check if this is a benign after-hours rejection
      const errorMessage = orderError instanceof Error ? orderError.message : String(orderError);
      
      // Log the full error details for debugging
      console.error('[exit][order][error][full]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        error_message: errorMessage,
        error_type: orderError instanceof Error ? orderError.constructor.name : typeof orderError,
        error_stack: orderError instanceof Error ? orderError.stack : undefined,
        timestamp: now.toISOString(),
      }));
      
      if (isBenignRejection(errorMessage)) {
        // After-hours rejection - log as benign, don't trigger emergency
        console.log('[exit][order][rejected]', JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          code: 'MARKET_CLOSED',
          message: errorMessage,
          benign: true,
          timestamp: now.toISOString(),
        }));
        
        return {
          trade,
          trigger: decision.trigger,
          success: false,
          reason: `Market closed: ${errorMessage}`,
        };
      }
      
      // Real error - market orders should handle fallback internally
      // If market order placement failed, mark as error and retry on next cycle
      console.error('[exit][market-order][error]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        error_message: errorMessage,
        note: 'Market order placement failed - will retry on next cycle',
        timestamp: now.toISOString(),
      }));
      
      // Mark as EXIT_ERROR if this is a persistent issue
      const errorTrade = await updateTrade(env, trade.id, {
        status: 'EXIT_ERROR',
        exit_reason: exitReason,
      });
      
      return {
        trade: errorTrade,
        trigger: decision.trigger,
        success: false,
        reason: `Market order placement failed: ${errorMessage}`,
      };
    }
    
    // Mark as CLOSING_PENDING
    // Use primary order ID for tracking (for per-leg orders, we track the first one)
    const updatedTrade = await markTradeClosingPending(
      env,
      trade.id,
      exitReason,
      now,
      primaryOrderId
    );
    // Market orders don't have a limit price, so pass 0 for notification
    await notifyExitSubmitted(env, tradingMode, updatedTrade, 0);
    
    // Poll for fill
    const fillResult = await pollForExitFill(broker, updatedTrade, primaryOrderId, now);
    
    if (fillResult.filled && fillResult.fillPrice !== undefined) {
      // Mark as closed - exit_reason should already be set from markTradeClosingPending above
      const closedTrade = await markTradeClosedWithReason(
        env,
        trade.id,
        fillResult.fillPrice,
        new Date(),
        exitReason // Pass exit_reason to ensure it's preserved
      );
      
      // Record in risk system
      await recordTradeClosed(env, closedTrade);
      
      // Track emergency exits only after we successfully closed the trade
      if (decision.trigger === 'EMERGENCY') {
        await incrementEmergencyExitCount(env, now);
      }
      
      // Immediately re-sync from Tradier after closing (per Tradier-first spec)
      console.log('[exit] order filled, re-syncing from Tradier', JSON.stringify({
        trade_id: trade.id,
        orderId: order.id,
        fillPrice: fillResult.fillPrice,
      }));
      
      const { syncPortfolioFromTradier } = await import('./portfolioSync');
      const { syncOrdersFromTradier } = await import('./orderSync');
      const { syncBalancesFromTradier } = await import('./balancesSync');
      
      await syncPortfolioFromTradier(env);
      await syncOrdersFromTradier(env);
      await syncBalancesFromTradier(env);
      
      return {
        trade: closedTrade,
        trigger: decision.trigger,
        success: true,
      };
    } else {
      // Try one retry with market orders (should fill immediately)
      console.log('[exit][initial-fill-failed][retrying]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        order_id: order.id,
        order_status: (await broker.getOrder(order.id)).status,
        note: 'Initial market exit order did not fill - will retry on next cycle',
      }));
      
      // Cancel the initial order before retry
      try {
        await broker.cancelOrder(order.id);
        console.log('[exit][retry][cancelled-initial-order]', JSON.stringify({
          trade_id: trade.id,
          cancelled_order_id: order.id,
        }));
      } catch (err) {
        // Ignore cancellation errors - order may have already filled or been cancelled
        console.warn('[exit][retry][cancel-failed]', JSON.stringify({
          trade_id: trade.id,
          order_id: order.id,
          error: err instanceof Error ? err.message : String(err),
          note: 'Failed to cancel initial order - proceeding with retry anyway',
        }));
      }
      
      return await retryExit(env, broker, updatedTrade, decision, now);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check if this is a benign after-hours rejection
    const { isBenignRejection } = await import('../core/systemMode');
    if (isBenignRejection(errorMessage)) {
      console.log('[exit][order][rejected]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        code: 'MARKET_CLOSED',
        message: errorMessage,
        benign: true,
        timestamp: new Date().toISOString(),
      }));
      
      return {
        trade,
        trigger: decision.trigger,
        success: false,
        reason: `Market closed: ${errorMessage}`,
      };
    }
    
    // Real error - log and return failure
    console.error('[exit][error]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    }));
    
    return {
      trade,
      trigger: decision.trigger,
      success: false,
      reason: errorMessage,
    };
  }
}

/**
 * Check pending exits and update status
 * 
 * Per system-interfaces.md:
 * export async function checkPendingExits(
 *   env: Env,
 *   now: Date
 * ): Promise<void>;
 * 
 * NOTE: This function is intentionally "hands-off" - it only handles FILLED orders.
 * All retries, cancellations, and error handling are done by the main exit engine
 * (executeExitForTrade) when re-triggered by the monitoring cycle.
 * 
 * This design assumes the monitoring loop will re-evaluate exits until truly closed.
 * If a trade is in CLOSING_PENDING with an OPEN broker order that times out,
 * the exit engine will handle retry on the next monitoring cycle.
 */
export async function checkPendingExits(
  env: Env,
  now: Date
): Promise<void> {
  const { getTradesByStatus, getOpenTrades } = await import('../db/queries');
  const pendingTrades = await getTradesByStatus(env, 'CLOSING_PENDING');
  
  // Also check for trades that are OPEN but have a broker_order_id_close set
  // This catches cases where a trade should be CLOSING_PENDING but isn't
  const openTrades = await getOpenTrades(env);
  const openTradesWithCloseOrders = openTrades.filter(t => t.broker_order_id_close && t.status === 'OPEN');
  
  // CRITICAL: Also check for OPEN trades that have an exit_reason but no broker_order_id_close
  // This handles cases where the exit order was canceled and cleared, but the trade should still be closing
  const openTradesWithExitReason = openTrades.filter(t => 
    t.status === 'OPEN' && 
    !t.broker_order_id_close && 
    t.exit_reason && 
    t.exit_reason !== 'NORMAL_EXIT' // Only check trades that have an explicit exit reason
  );
  
  // Combine all sets
  const allTradesToCheck = [
    ...pendingTrades,
    ...openTradesWithCloseOrders,
    ...openTradesWithExitReason,
  ];
  
  // Deduplicate by trade ID
  const uniqueTrades = Array.from(
    new Map(allTradesToCheck.map(t => [t.id, t])).values()
  );
  
  // DEBUG: Check for trade 134 specifically
  const trade134 = uniqueTrades.find(t => t.id === '134');
  if (trade134) {
    console.log('[exit][checkPendingExits][debug][trade-134]', JSON.stringify({
      timestamp: now.toISOString(),
      trade_id: trade134.id,
      symbol: trade134.symbol,
      status: trade134.status,
      entry_price: trade134.entry_price,
      exit_price: trade134.exit_price,
      broker_order_id_open: trade134.broker_order_id_open,
      broker_order_id_close: trade134.broker_order_id_close,
      exit_reason: trade134.exit_reason,
      in_pending_trades: pendingTrades.some(t => t.id === '134'),
      in_open_with_close_orders: openTradesWithCloseOrders.some(t => t.id === '134'),
    }));
  }
  
  console.log('[exit][checkPendingExits][start]', JSON.stringify({
    timestamp: now.toISOString(),
    pending_trades_count: pendingTrades.length,
    open_trades_with_close_orders_count: openTradesWithCloseOrders.length,
    open_trades_with_exit_reason_count: openTradesWithExitReason.length,
    total_trades_to_check: uniqueTrades.length,
    trade_ids: uniqueTrades.map(t => t.id),
    pending_trade_ids: pendingTrades.map(t => t.id),
    open_with_close_order_ids: openTradesWithCloseOrders.map(t => t.id),
    open_with_exit_reason_ids: openTradesWithExitReason.map(t => t.id),
  }));
  
  const broker = new TradierClient(env);
  
  // Check for orphan orders (OPEN orders in Tradier that aren't linked to any trade)
  // Try to match them to trades by option symbols
  const { getOrder } = await import('../db/queries');
  const openOrders = await broker.getOpenOrders();
  const orphanOrders: Array<{ orderId: string; order: any; orderDetails: any }> = [];
  
  // Get all known close order IDs from trades
  const knownCloseOrderIds = new Set(
    uniqueTrades
      .map(t => t.broker_order_id_close)
      .filter((id): id is string => !!id)
  );
  
  // Find orphan orders (orders in Tradier open orders list that aren't linked to any trade)
  // CRITICAL: Check ALL orders from getOpenOrders() regardless of their status in the list,
  // because we need to verify their actual status from Tradier and handle stale close orders
  for (const order of openOrders) {
    // Skip if already linked to a trade
    if (knownCloseOrderIds.has(order.id)) {
      continue;
    }
    
    try {
      // Get actual order status from Tradier (more reliable than list status)
      const orderDetails = await broker.getOrderWithLegs(order.id);
      const actualOrder = await broker.getOrder(order.id);
      const actualStatus = (actualOrder.status || '').toUpperCase();
      
      // Check if this is actually an open order (OPEN, NEW, PENDING)
      // If it's in the open orders list, we should check it even if status seems wrong
      const isActuallyOpen = actualStatus === 'OPEN' || actualStatus === 'NEW' || actualStatus === 'PENDING';
      
      // Also check if it's a multileg order (likely a close order)
      const isMultileg = (orderDetails.class || '').toLowerCase() === 'multileg';
      const hasMultipleLegs = (orderDetails.leg || []).length >= 2;
      
      if (isActuallyOpen || (isMultileg && hasMultipleLegs)) {
        // Check if order is stale (open > 60 seconds)
        const orderCreatedAt = order.created_at || orderDetails.created_at || orderDetails.create_date;
        const orderCreatedAtDate = orderCreatedAt ? new Date(orderCreatedAt) : null;
        const orderAge = orderCreatedAtDate ? now.getTime() - orderCreatedAtDate.getTime() : 0;
        const isStale = orderAge > MARKET_LIKE_TIMEOUT_MS;
        
        console.log('[exit][checkPendingExits][checking-open-order]', JSON.stringify({
          order_id: order.id,
          list_status: order.status,
          actual_status: actualStatus,
          is_actually_open: isActuallyOpen,
          is_multileg: isMultileg,
          has_multiple_legs: hasMultipleLegs,
          order_age_ms: orderAge,
          is_stale: isStale,
          created_at: orderCreatedAt,
          note: isStale ? 'Order is stale - will cancel and resubmit if matched to trade' : 'Checking order',
        }));
        
        orphanOrders.push({ 
          orderId: order.id, 
          order: { ...order, status: actualStatus }, // Use actual status
          orderDetails 
        });
      }
    } catch (err) {
      console.warn('[exit][checkPendingExits][orphan-order-fetch-error]', JSON.stringify({
        order_id: order.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  
  console.log('[exit][checkPendingExits][orphan-orders]', JSON.stringify({
    orphan_count: orphanOrders.length,
    orphan_order_ids: orphanOrders.map(o => o.orderId),
  }));
  
  // Try to match orphan orders to trades
  // CRITICAL: First, check portfolio_positions to find positions that match orphan orders
  // The positions exist in portfolio_positions even if the trade doesn't exist or is CLOSED
  const { getAllPortfolioPositions, getAllTrades } = await import('../db/queries');
  const allPositions = await getAllPortfolioPositions(env);
  
  // Find AAPL positions that match the orphan orders (290/295 calls expiring 2026-01-02)
  // Don't filter by quantity - we want to find all matching positions
  const aaplPositions = allPositions.filter(p => 
    p.symbol === 'AAPL' && 
    p.expiration === '2026-01-02' &&
    p.option_type === 'call' &&
    (p.strike === 290 || p.strike === 295)
  );
  
  console.log('[exit][checkPendingExits][aapl-positions-found]', JSON.stringify({
    aapl_positions_count: aaplPositions.length,
    aapl_positions: aaplPositions.map(p => ({
      strike: p.strike,
      side: p.side,
      quantity: p.quantity,
      option_type: p.option_type,
    })),
    note: 'Found AAPL positions in portfolio_positions that might match orphan orders',
  }));
  
  // Get all trades to match against
  const allTradesInDb = await getAllTrades(env, 1000);
  
  // Find trades that match the AAPL positions (290/295 strikes)
  // Don't require positions to exist - just find trades with matching strikes
  const aaplTrades = allTradesInDb.filter(t => 
    t.symbol === 'AAPL' && 
    t.expiration === '2026-01-02' &&
    ((t.short_strike === 290 && t.long_strike === 295) ||
     (t.short_strike === 295 && t.long_strike === 290))
  );
  
  console.log('[exit][checkPendingExits][aapl-trades-found]', JSON.stringify({
    aapl_trades_count: aaplTrades.length,
    aapl_trade_ids: aaplTrades.map(t => t.id),
    aapl_trade_statuses: aaplTrades.map(t => t.status),
    aapl_trade_quantities: aaplTrades.map(t => t.quantity),
    aapl_trade_strikes: aaplTrades.map(t => ({ short: t.short_strike, long: t.long_strike })),
    note: 'Found AAPL trades that match portfolio positions',
  }));
  
  // Check all trades (open, pending, and AAPL trades from positions) to find matches
  const allTradesForMatchingMap = new Map<string, TradeRow>();
  for (const trade of openTrades) {
    allTradesForMatchingMap.set(trade.id, trade);
  }
  for (const trade of pendingTrades) {
    allTradesForMatchingMap.set(trade.id, trade);
  }
  for (const trade of aaplTrades) {
    allTradesForMatchingMap.set(trade.id, trade);
  }
  const allTradesForMatching = Array.from(allTradesForMatchingMap.values());
  
  // Log all trades being checked for matching
  console.log('[exit][checkPendingExits][orphan-matching-setup]', JSON.stringify({
    orphan_orders_count: orphanOrders.length,
    trades_available_for_matching: allTradesForMatching.length,
    trade_ids: allTradesForMatching.map(t => t.id),
    trade_symbols: allTradesForMatching.map(t => t.symbol),
    trade_statuses: allTradesForMatching.map(t => t.status),
    note: 'Setting up orphan order matching',
  }));
  
  if (orphanOrders.length > 0 && allTradesForMatching.length > 0) {
    for (const { orderId, order, orderDetails } of orphanOrders) {
      const legs = orderDetails.leg || [];
      if (legs.length < 2) continue; // Skip single-leg orders
      
      // Extract option symbols from order legs
      const orderOptionSymbols = new Set(
        legs.map((leg: any) => leg.option_symbol).filter((s: any): s is string => !!s)
      );
      
      // Log order details for debugging
      console.log('[exit][checkPendingExits][orphan-order-details]', JSON.stringify({
        order_id: orderId,
        order_status: order.status,
        order_option_symbols: Array.from(orderOptionSymbols),
        remaining_quantity: order.remaining_quantity,
        legs_count: legs.length,
        note: 'Processing orphan order for matching',
      }));
      
      // Try to match to a trade
      // CRITICAL: Check ALL trades, including those with canceled close orders
      // We need to match orphan orders even if the trade has a broker_order_id_close that points to a canceled order
      for (const trade of allTradesForMatching) {
        // Skip only if trade has a close order that is NOT canceled/rejected/expired
        // If the close order is canceled, we should still match orphan orders
        if (trade.broker_order_id_close) {
          // Check if the existing close order is actually still open
          try {
            const existingOrder = await broker.getOrder(trade.broker_order_id_close);
            const existingOrderStatus = (existingOrder.status || '').toUpperCase();
            const isTerminated = ['CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'FILLED'].includes(existingOrderStatus);
            
            // If the existing order is not terminated, skip this trade (it already has an active close order)
            if (!isTerminated) {
              continue;
            }
            // If it's terminated, we can still match orphan orders to this trade
          } catch (err) {
            // If we can't check the order status, assume it might be canceled and continue matching
            console.warn('[exit][checkPendingExits][orphan-order-check-existing-failed]', JSON.stringify({
              trade_id: trade.id,
              broker_order_id_close: trade.broker_order_id_close,
              error: err instanceof Error ? err.message : String(err),
              note: 'Could not check existing close order status - will attempt to match orphan orders',
            }));
          }
        }
        
        // Determine option type from strategy
        const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
        
        // Format option symbols (Tradier format: SYMBOL + YYMMDD + C/P + STRIKE)
        // Example: AAPL260102C00290000
        const formatOptionSymbol = (symbol: string, expiration: string, strike: number, type: 'call' | 'put'): string => {
          // Convert expiration YYYY-MM-DD to YYMMDD
          const expDate = new Date(expiration);
          const yy = expDate.getFullYear().toString().slice(-2);
          const mm = String(expDate.getMonth() + 1).padStart(2, '0');
          const dd = String(expDate.getDate()).padStart(2, '0');
          const expStr = `${yy}${mm}${dd}`;
          
          // Format strike (multiply by 1000, pad to 8 digits)
          const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
          
          const optionTypeChar = type === 'call' ? 'C' : 'P';
          return `${symbol}${expStr}${optionTypeChar}${strikeStr}`;
        };
        
        const shortOptionSymbol = formatOptionSymbol(trade.symbol, trade.expiration, trade.short_strike, optionType);
        const longOptionSymbol = formatOptionSymbol(trade.symbol, trade.expiration, trade.long_strike, optionType);
        
        // Log matching attempt for debugging
        console.log('[exit][checkPendingExits][orphan-order-matching-attempt]', JSON.stringify({
          order_id: orderId,
          trade_id: trade.id,
          symbol: trade.symbol,
          status: trade.status,
          short_option: shortOptionSymbol,
          long_option: longOptionSymbol,
          order_option_symbols: Array.from(orderOptionSymbols),
          broker_order_id_close: trade.broker_order_id_close,
          note: 'Attempting to match orphan order to trade',
        }));
        
        // Check if order contains both option symbols (it's a close order for this trade)
        if (orderOptionSymbols.has(shortOptionSymbol) && orderOptionSymbols.has(longOptionSymbol)) {
          // Check if order is stale (open too long)
          const orderCreatedAt = order.created_at ? new Date(order.created_at) : null;
          const orderAge = orderCreatedAt ? now.getTime() - orderCreatedAt.getTime() : 0;
          const isStale = orderAge > MARKET_LIKE_TIMEOUT_MS;
          
          console.log('[exit][checkPendingExits][orphan-order-matched]', JSON.stringify({
            order_id: orderId,
            trade_id: trade.id,
            symbol: trade.symbol,
            short_option: shortOptionSymbol,
            long_option: longOptionSymbol,
            order_option_symbols: Array.from(orderOptionSymbols),
            order_age_ms: orderAge,
            is_stale: isStale,
            note: isStale 
              ? 'Orphan order matched to trade and is STALE - will link, cancel, and resubmit immediately'
              : 'Orphan order matched to trade - will link and process',
          }));
          
          // Update trade with the close order ID
          const { markTradeClosingPending } = await import('./lifecycle');
          const exitReason = trade.exit_reason || 'NORMAL_EXIT';
          await markTradeClosingPending(env, trade.id, exitReason, now, orderId);
          
          // If stale, cancel immediately and it will be resubmitted in the processing loop
          if (isStale) {
            console.log('[exit][checkPendingExits][orphan-order-stale-cancelling]', JSON.stringify({
              order_id: orderId,
              trade_id: trade.id,
              order_age_ms: orderAge,
              timeout_ms: MARKET_LIKE_TIMEOUT_MS,
              note: 'Cancelling stale orphan order - will resubmit with market-like pricing',
            }));
            
            try {
              // Cancel ALL open close orders for these positions first
              const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
              const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
              const shortOption = optionChain.find(
                opt => opt.strike === trade.short_strike && opt.type === optionType
              );
              const longOption = optionChain.find(
                opt => opt.strike === trade.long_strike && opt.type === optionType
              );
              
              if (shortOption && longOption) {
                await cancelOpenCloseOrders(broker, shortOption.symbol, longOption.symbol);
              }
              
              // Also cancel this specific order
              await broker.cancelOrder(orderId);
              
              console.log('[exit][checkPendingExits][orphan-order-cancelled]', JSON.stringify({
                order_id: orderId,
                trade_id: trade.id,
                note: 'Stale orphan order cancelled - will be resubmitted with market-like pricing',
              }));
            } catch (err) {
              console.error('[exit][checkPendingExits][orphan-order-cancel-error]', JSON.stringify({
                order_id: orderId,
                trade_id: trade.id,
                error: err instanceof Error ? err.message : String(err),
              }));
            }
          }
          
          // Add to list of trades to process
          const { getTrade } = await import('../db/queries');
          const updatedTrade = await getTrade(env, trade.id);
          if (updatedTrade) {
            uniqueTrades.push(updatedTrade);
          }
          
          break; // Found a match, move to next orphan order
        }
      }
      
      // If no match found and order is stale, cancel it
      if (order.created_at) {
        const orderCreatedAt = new Date(order.created_at);
        const orderAge = now.getTime() - orderCreatedAt.getTime();
        
        if (orderAge > MARKET_LIKE_TIMEOUT_MS) {
          console.log('[exit][checkPendingExits][orphan-order-stale]', JSON.stringify({
            order_id: orderId,
            order_age_ms: orderAge,
            timeout_ms: MARKET_LIKE_TIMEOUT_MS,
            note: 'Orphan order is stale and unmatched - cancelling',
          }));
          
          try {
            await broker.cancelOrder(orderId);
            console.log('[exit][checkPendingExits][orphan-order-cancelled]', JSON.stringify({
              order_id: orderId,
              note: 'Stale orphan order cancelled',
            }));
          } catch (err) {
            console.error('[exit][checkPendingExits][orphan-order-cancel-error]', JSON.stringify({
              order_id: orderId,
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        }
      }
    }
  }
  
  // Deduplicate again after adding matched trades
  const finalTradesToCheck = Array.from(
    new Map(uniqueTrades.map(t => [t.id, t])).values()
  );
  
  console.log('[exit][checkPendingExits][after-orphan-matching]', JSON.stringify({
    final_trades_count: finalTradesToCheck.length,
    trade_ids: finalTradesToCheck.map(t => t.id),
  }));
  
  if (finalTradesToCheck.length === 0) {
    return;
  }
  
  for (const trade of finalTradesToCheck) {
    // DEBUG: Enhanced logging for trade 134
    if (trade.id === '134') {
      console.log('[exit][checkPendingExits][debug][trade-134][processing]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        status: trade.status,
        entry_price: trade.entry_price,
        exit_price: trade.exit_price,
        broker_order_id_close: trade.broker_order_id_close,
        exit_reason: trade.exit_reason,
        timestamp: now.toISOString(),
      }));
    }
    
    console.log('[exit][checkPendingExits][processing-trade]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      status: trade.status,
      broker_order_id_close: trade.broker_order_id_close,
      note: trade.status === 'OPEN' ? 'Trade is OPEN but has close order - will check and update status' : 'Trade is CLOSING_PENDING',
    }));
    
    // If trade is OPEN but has a close order, update status to CLOSING_PENDING
    if (trade.status === 'OPEN' && trade.broker_order_id_close) {
      console.log('[exit][checkPendingExits][fixing-status]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        old_status: trade.status,
        new_status: 'CLOSING_PENDING',
        broker_order_id_close: trade.broker_order_id_close,
        note: 'Trade has close order but is OPEN - updating to CLOSING_PENDING',
      }));

      const { markTradeClosingPending } = await import('./lifecycle');
      const exitReason = trade.exit_reason || 'NORMAL_EXIT';
      await markTradeClosingPending(env, trade.id, exitReason, now, trade.broker_order_id_close);
      
      // Refresh trade data
      const { getTrade } = await import('../db/queries');
      const updatedTrade = await getTrade(env, trade.id);
      if (!updatedTrade) {
        console.error('[exit][checkPendingExits][trade-not-found]', JSON.stringify({
          trade_id: trade.id,
          note: 'Trade not found after status update',
        }));
        continue;
      }
      // Update the trade object with fresh data
      Object.assign(trade, updatedTrade);
    }
    
    // CRITICAL: If trade is OPEN with exit_reason but no broker_order_id_close,
    // it means the exit order was canceled and cleared. Re-evaluate and resubmit if trigger is still active.
    if (trade.status === 'OPEN' && !trade.broker_order_id_close && trade.exit_reason && trade.exit_reason !== 'NORMAL_EXIT') {
      console.log('[exit][checkPendingExits][open-trade-with-exit-reason]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        exit_reason: trade.exit_reason,
        note: 'Trade is OPEN with exit_reason but no close order - re-evaluating exit trigger',
      }));
      
      // Re-evaluate the trade to check if exit trigger is still active
      const { evaluateOpenTrade } = await import('./monitoring');
      const decision = await evaluateOpenTrade(env, trade, now);
      
      if (decision.trigger !== 'NONE') {
        // Exit trigger is still active - resubmit immediately
        console.log('[exit][checkPendingExits][resubmitting-open-trade-with-exit-reason]', JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          trigger: decision.trigger,
          current_mark: decision.metrics.current_mark,
          exit_reason: trade.exit_reason,
          note: 'Exit trigger still active for trade with exit_reason - resubmitting exit order',
        }));
        
        try {
          const exitResult = await executeExitForTrade(env, trade, decision, now);
          console.log('[exit][checkPendingExits][resubmitted-open-trade-success]', JSON.stringify({
            trade_id: trade.id,
            success: exitResult.success,
            order_id: exitResult.trade?.broker_order_id_close,
            trigger: decision.trigger,
            reason: exitResult.reason,
            note: 'Exit order resubmitted for trade with exit_reason',
          }));
        } catch (err) {
          console.error('[exit][checkPendingExits][resubmit-open-trade-error]', JSON.stringify({
            trade_id: trade.id,
            error: err instanceof Error ? err.message : String(err),
            note: 'Failed to resubmit exit order for trade with exit_reason - will retry on next cycle',
          }));
        }
        continue; // Skip the rest of the processing for this trade
      } else {
        // Exit trigger is no longer active - clear the exit_reason and let trade continue
        console.log('[exit][checkPendingExits][exit-trigger-cleared-for-open-trade]', JSON.stringify({
          trade_id: trade.id,
          exit_reason: trade.exit_reason,
          trigger: decision.trigger,
          note: 'Exit trigger no longer active - clearing exit_reason, trade will continue',
        }));
        
        await updateTrade(env, trade.id, {
          exit_reason: null,
        });
        continue; // Skip the rest of the processing for this trade
      }
    }
    
    if (!trade.broker_order_id_close) {
      // Missing order ID - mark as failed
      console.warn('[exit][checkPendingExits][missing-order-id]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        note: 'Missing broker order ID for exit - marking as cancelled',
      }));
      await markTradeCancelled(env, trade.id, 'Missing broker order ID for exit');
      continue;
    }
    
    try {
      console.log('[exit][checkPendingExits][fetching-order]', JSON.stringify({
        trade_id: trade.id,
        order_id: trade.broker_order_id_close,
      }));
      
      // Use getOrderWithLegs for multileg orders to get complete details
      // This gives us full order information including leg details
      const orderDetails = await broker.getOrderWithLegs(trade.broker_order_id_close);
      
      // Also get the standard BrokerOrder for status checking
      const order = await broker.getOrder(trade.broker_order_id_close);
      
      console.log('[exit][checkPendingExits][order-fetched]', JSON.stringify({
        trade_id: trade.id,
        order_id: trade.broker_order_id_close,
        order_status: order.status,
        order_created_at: order.created_at || orderDetails.created_at || orderDetails.create_date || 'null',
        order_updated_at: order.updated_at || orderDetails.updated_at || orderDetails.transaction_date || 'null',
        order_type: orderDetails.type,
        order_class: orderDetails.class,
        filled_quantity: order.filled_quantity || orderDetails.filled_quantity || 0,
        remaining_quantity: order.remaining_quantity || orderDetails.remaining_quantity || 0,
        note: 'Using Tradier order API to track order status',
      }));
      
      // Check for filled status (handle case variations)
      // Check both order.status and orderDetails.status - Tradier may return different statuses in different places
      const orderStatusUpper = (order.status || '').toUpperCase();
      const orderDetailsStatusUpper = (orderDetails.status || '').toUpperCase();
      const isFilled = orderStatusUpper === 'FILLED' || 
                      orderStatusUpper === 'FULLY_FILLED' ||
                      orderDetailsStatusUpper === 'FILLED' ||
                      orderDetailsStatusUpper === 'FULLY_FILLED' ||
                      (order.filled_quantity && order.filled_quantity > 0 && order.remaining_quantity === 0);
      
      // Check if order is in open orders list (might be stale even if status says otherwise)
      const isInOpenOrders = openOrders.some(o => o.id === trade.broker_order_id_close);
      
      // Calculate order age for stale checking
      const orderCreatedAtStr = order.created_at 
        || orderDetails.created_at 
        || orderDetails.create_date
        || trade.updated_at 
        || trade.opened_at 
        || trade.created_at 
        || now.toISOString();
      const orderCreatedAt = new Date(orderCreatedAtStr);
      const orderAge = now.getTime() - orderCreatedAt.getTime();
      
      // Check for terminated status (cancelled, rejected, expired) - check both sources
      const terminatedStatuses = ['CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED'];
      const isTerminated = terminatedStatuses.includes(orderStatusUpper) || 
                          terminatedStatuses.includes(orderDetailsStatusUpper);
      
      console.log('[exit][checkPendingExits][order-status-check]', JSON.stringify({
        trade_id: trade.id,
        order_id: trade.broker_order_id_close,
        order_status: order.status,
        order_status_upper: orderStatusUpper,
        order_details_status: orderDetails.status,
        order_details_status_upper: orderDetailsStatusUpper,
        is_filled: isFilled,
        is_terminated: isTerminated,
        is_in_open_orders: isInOpenOrders,
        order_age_ms: orderAge,
        note: 'Checking order status from both order and orderDetails',
      }));
      
      // CRITICAL: If order is in open orders list and is stale (> 60 seconds), treat it as open and resubmit
      // This handles cases where Tradier shows order as CANCELLED but it's still in open orders list
      if (isInOpenOrders && orderAge > MARKET_LIKE_TIMEOUT_MS && !isFilled && !isTerminated) {
        console.log('[exit][checkPendingExits][stale-order-in-open-list]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_close,
          order_status: order.status,
          order_status_upper: orderStatusUpper,
          order_age_ms: orderAge,
          is_in_open_orders: isInOpenOrders,
          note: 'Order is in open orders list and is stale - treating as open and will cancel/resubmit',
        }));
        // Fall through to stale order handling below
      } else if (isFilled) {
        // Try to get fill price from multiple sources
        const fillPrice = order.avg_fill_price || 
                         orderDetails.avg_fill_price || 
                         orderDetails.price || 
                         null;
        
        if (fillPrice === null || fillPrice === 0) {
          // Data error - log but try to continue with a default
          console.warn('[exit][checkPendingExits][missing-fill-price]', JSON.stringify({
            trade_id: trade.id,
            order_id: trade.broker_order_id_close,
            order_status: order.status,
            avg_fill_price: order.avg_fill_price,
            order_details_avg_fill_price: orderDetails.avg_fill_price,
            filled_quantity: order.filled_quantity,
            remaining_quantity: order.remaining_quantity,
            note: 'Order is filled but missing fill price - using trade exit_price or 0',
          }));
          
          // Use trade.exit_price if available, otherwise 0 (will be updated by order sync)
          const fallbackPrice = trade.exit_price || 0;
          
          // Mark as closed even without fill price - order sync will update it
          const closedTrade = await markTradeClosedWithReason(
            env,
            trade.id,
            fallbackPrice,
            now,
            trade.exit_reason ?? 'NORMAL_EXIT'
          );
          
          await recordTradeClosed(env, closedTrade);
          
          console.log('[exit][checkPendingExits][closed-without-fill-price]', JSON.stringify({
            trade_id: trade.id,
            exit_price: fallbackPrice,
            note: 'Trade closed but fill price missing - order sync should update it',
          }));
        } else {
        // Mark as closed - exit_reason should already be set from markTradeClosingPending
        const closedTrade = await markTradeClosedWithReason(
          env,
          trade.id,
            fillPrice,
          now,
          trade.exit_reason ?? 'NORMAL_EXIT' // Preserve existing exit_reason or default to NORMAL_EXIT
        );
        
        // Record in risk system
        await recordTradeClosed(env, closedTrade);
          
          console.log('[exit][checkPendingExits][closed-successfully]', JSON.stringify({
            trade_id: trade.id,
            order_id: trade.broker_order_id_close,
            exit_price: fillPrice,
            exit_reason: closedTrade.exit_reason,
          }));
        }
      } else if (isTerminated) {
        // Order cancelled/rejected/expired - check if exit trigger is still active and resubmit immediately
        console.log('[exit][checkPendingExits][order-terminated]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_close,
          order_status: order.status,
          order_status_upper: orderStatusUpper,
          order_details_status: orderDetails.status,
          order_details_status_upper: orderDetailsStatusUpper,
          note: 'Order is terminated - checking if exit trigger is still active to resubmit',
        }));
        
        // Re-evaluate the trade to check if exit trigger is still active
        const { evaluateOpenTrade } = await import('./monitoring');
        const decision = await evaluateOpenTrade(env, trade, now);
        
        if (decision.trigger !== 'NONE') {
          // Exit trigger is still active - resubmit immediately
          console.log('[exit][checkPendingExits][resubmitting-terminated-order]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            trigger: decision.trigger,
            current_mark: decision.metrics.current_mark,
            old_order_id: trade.broker_order_id_close,
            note: 'Exit trigger still active - clearing old order ID and resubmitting immediately',
          }));
          
          // Clear the old order ID so we can place a new order
          await updateTrade(env, trade.id, {
            broker_order_id_close: null,
            status: 'OPEN', // Reset to OPEN so exit engine can process it
          });
          
          // Refresh trade data after update
          const { getTrade } = await import('../db/queries');
          const updatedTrade = await getTrade(env, trade.id);
          if (!updatedTrade) {
            console.error('[exit][checkPendingExits][trade-not-found-after-update]', JSON.stringify({
              trade_id: trade.id,
              note: 'Trade not found after clearing order ID',
        }));
        continue;
          }
          
          // Resubmit the exit order immediately
          try {
            const exitResult = await executeExitForTrade(env, updatedTrade, decision, now);
            console.log('[exit][checkPendingExits][resubmitted-successfully]', JSON.stringify({
              trade_id: trade.id,
              success: exitResult.success,
              order_id: exitResult.trade?.broker_order_id_close,
              trigger: decision.trigger,
              reason: exitResult.reason,
              note: 'Exit order resubmitted successfully after cancellation',
            }));
          } catch (err) {
            console.error('[exit][checkPendingExits][resubmit-error]', JSON.stringify({
              trade_id: trade.id,
              error: err instanceof Error ? err.message : String(err),
              note: 'Failed to resubmit exit order - will retry on next cycle',
            }));
          }
        } else {
          // Exit trigger is no longer active - clear the order ID and let trade continue
          console.log('[exit][checkPendingExits][exit-trigger-cleared]', JSON.stringify({
            trade_id: trade.id,
            order_id: trade.broker_order_id_close,
            trigger: decision.trigger,
            note: 'Exit trigger no longer active - clearing order ID, trade will continue',
          }));
          
          await updateTrade(env, trade.id, {
            broker_order_id_close: null,
            status: 'OPEN',
          });
        }
        continue;
      } else if (['OPEN', 'NEW', 'PENDING'].includes(orderStatusUpper) || (isInOpenOrders && orderAge > MARKET_LIKE_TIMEOUT_MS)) {
        console.log('[exit][checkPendingExits][order-still-open]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_close,
          order_status: order.status,
          is_in_open_orders: isInOpenOrders,
          order_age_ms: orderAge,
          note: isInOpenOrders && orderAge > MARKET_LIKE_TIMEOUT_MS 
            ? 'Order is in open orders list and is stale - checking timeout'
            : 'Order is still open - checking timeout',
        }));
        // Check if order has been open for > 20 seconds (timeout threshold)
        // Order age already calculated above
        const TIMEOUT_MS = 20 * 1000; // 20 seconds
        const MARKET_LIKE_TIMEOUT = MARKET_LIKE_TIMEOUT_MS; // 60 seconds - use market-like pricing
        
        console.log('[exit][checkPendingExits][order-age-check]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_close,
          order_status: order.status,
          order_created_at: order.created_at || 'unknown',
          trade_updated_at: trade.updated_at,
          order_age_ms: orderAge,
          timeout_ms: TIMEOUT_MS,
          market_like_timeout_ms: MARKET_LIKE_TIMEOUT,
          should_retry: orderAge > TIMEOUT_MS,
          should_use_market_like: orderAge > MARKET_LIKE_TIMEOUT,
        }));
        
        if (orderAge > MARKET_LIKE_TIMEOUT) {
          // Order has been open > 30 seconds - use market-like pricing to force fill
          console.log('[exit][checkPendingExits][market-like-timeout]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            broker_order_id_close: trade.broker_order_id_close,
            order_status: order.status,
            order_age_ms: orderAge,
            timeout_ms: MARKET_LIKE_TIMEOUT,
            note: 'Order has been open > 30 seconds - cancelling and resubmitting with market-like pricing',
          }));
          
          // Re-evaluate the trade to get fresh monitoring decision
          const { evaluateOpenTrade } = await import('./monitoring');
          const decision = await evaluateOpenTrade(env, trade, now);
          
          // If we still have an exit trigger, cancel and resubmit with market-like pricing
          if (decision.trigger !== 'NONE') {
            // CRITICAL: Cancel ALL open close orders for these positions FIRST
            // This prevents duplicate orders and ensures we're not trying to close positions already in an order
            // Get option symbols first to identify which orders to cancel
            const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
            const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
            const shortOption = optionChain.find(
              opt => opt.strike === trade.short_strike && opt.type === optionType
            );
            const longOption = optionChain.find(
              opt => opt.strike === trade.long_strike && opt.type === optionType
            );
            
            if (!shortOption || !longOption) {
              console.error('[exit][checkPendingExits][missing-options-for-market-like]', JSON.stringify({
                trade_id: trade.id,
                symbol: trade.symbol,
                expiration: trade.expiration,
                short_strike: trade.short_strike,
                long_strike: trade.long_strike,
                option_type: optionType,
                note: 'Cannot find option legs in chain - cannot place market-like order',
              }));
              continue;
            }
            
            // Cancel ALL open close orders for these option symbols (not just the one we know about)
            console.log('[exit][checkPendingExits][cancelling-all-close-orders]', JSON.stringify({
              trade_id: trade.id,
              short_option_symbol: shortOption.symbol,
              long_option_symbol: longOption.symbol,
              note: 'Cancelling ALL open close orders for these positions before placing market-like order',
            }));
            
            const cancelledCount = await cancelOpenCloseOrders(
              broker,
              shortOption.symbol,
              longOption.symbol
            );
            
            console.log('[exit][checkPendingExits][cancelled-close-orders]', JSON.stringify({
              trade_id: trade.id,
              cancelled_count: cancelledCount,
              note: 'Cancelled all open close orders - waiting before placing market-like order',
            }));
            
            // Wait for cancellations to process
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Reset trade status to OPEN
            await updateTrade(env, trade.id, {
              status: 'OPEN',
              broker_order_id_close: null,
            });
            
            // Place market-like exit order directly
            const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
            const marketLikeLimit = calculateMarketLikeLimitPrice(trade, isDebitSpread);
            
            console.log('[exit][checkPendingExits][placing-market-like-order]', JSON.stringify({
              trade_id: trade.id,
              symbol: trade.symbol,
              strategy: trade.strategy,
              is_debit_spread: isDebitSpread,
              market_like_limit: marketLikeLimit,
              note: 'Placing exit order with market-like pricing to guarantee fill',
            }));
            
            // Get quantities from positions
            const { getSpreadLegPositions } = await import('../db/queries');
            const { shortLeg, longLeg } = await getSpreadLegPositions(
              env,
              trade.symbol,
              trade.expiration,
              optionType,
              trade.short_strike,
              trade.long_strike
            );
            
            const snapshot = computeSpreadPositionSnapshot(trade, shortLeg, longLeg);
            const shortQtyToClose = Math.abs(snapshot.shortQty);
            const longQtyToClose = snapshot.longQty;
            
            if (shortQtyToClose === 0 || longQtyToClose === 0) {
              console.warn('[exit][checkPendingExits][no-positions-for-market-like]', JSON.stringify({
                trade_id: trade.id,
                short_qty: shortQtyToClose,
                long_qty: longQtyToClose,
                note: 'No positions available to close with market-like order',
              }));
              continue;
            }
            
            // Build legs for market-like order using symbols from chain
            let leg0: SpreadLeg, leg1: SpreadLeg;
            if (isDebitSpread) {
              leg0 = { option_symbol: longOption.symbol, side: 'sell_to_close' as const, quantity: longQtyToClose };
              leg1 = { option_symbol: shortOption.symbol, side: 'buy_to_close' as const, quantity: shortQtyToClose };
            } else {
              leg0 = { option_symbol: shortOption.symbol, side: 'buy_to_close' as const, quantity: shortQtyToClose };
              leg1 = { option_symbol: longOption.symbol, side: 'sell_to_close' as const, quantity: longQtyToClose };
            }
            
            // Place market-like order
            const { generateClientOrderId, createOrderRecord } = await import('./orderHelpers');
            const { insertProposal } = await import('../db/queries');
            const exitProposal = await insertProposal(env, {
              id: crypto.randomUUID(),
              symbol: trade.symbol,
              expiration: trade.expiration,
              short_strike: trade.short_strike,
              long_strike: trade.long_strike,
              width: trade.width,
              quantity: trade.quantity,
              strategy: trade.strategy || 'BULL_PUT_CREDIT',
              credit_target: marketLikeLimit,
              score: 0,
              ivr_score: 0,
              vertical_skew_score: 0,
              term_structure_score: 0,
              delta_fitness_score: 0,
              ev_score: 0,
              status: 'READY',
              kind: 'EXIT',
              linked_trade_id: trade.id,
            });
            
            const clientOrderId = generateClientOrderId(exitProposal.id, 'EXIT');
            await createOrderRecord(env, exitProposal, 'EXIT', clientOrderId);
            
            const marketLikeOrder = await broker.placeSpreadOrder({
              symbol: trade.symbol,
              side: 'EXIT',
              legs: [leg0, leg1],
              tag: 'GEKKOWORKS-EXIT-MARKET-LIKE',
              strategy: trade.strategy!,
              limit_price: marketLikeLimit,
              client_order_id: clientOrderId,
            });
            
            const { updateOrderWithTradierResponse, linkOrderToTrade } = await import('./orderHelpers');
            await updateOrderWithTradierResponse(env, clientOrderId, marketLikeOrder.id, 'PLACED');
            await linkOrderToTrade(env, clientOrderId, trade.id);
            
            // Mark as CLOSING_PENDING with new order ID
            const { markTradeClosingPending } = await import('./lifecycle');
            const exitReason = trade.exit_reason || 'NORMAL_EXIT';
            await markTradeClosingPending(env, trade.id, exitReason, now, marketLikeOrder.id);
            
            console.log('[exit][checkPendingExits][market-like-order-placed]', JSON.stringify({
              trade_id: trade.id,
              order_id: marketLikeOrder.id,
              market_like_limit: marketLikeLimit,
              note: 'Market-like exit order placed successfully',
            }));
          } else {
            // No exit trigger - reset to OPEN
            await updateTrade(env, trade.id, {
              status: 'OPEN',
              broker_order_id_close: null,
            });
          }
        } else if (orderAge > TIMEOUT_MS) {
          // Order has been open > 20 seconds but < 30 seconds - retry with wider slippage
          console.log('[exit][checkPendingExits][timeout-detected]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            broker_order_id_close: trade.broker_order_id_close,
            order_status: order.status,
            order_age_ms: orderAge,
            timeout_ms: TIMEOUT_MS,
            note: 'Order has been open > 20 seconds - triggering retry with wider slippage',
          }));
          
          // Re-evaluate the trade to get fresh monitoring decision
          const { evaluateOpenTrade } = await import('./monitoring');
          const decision = await evaluateOpenTrade(env, trade, now);
          
          // If we still have an exit trigger (or it's still an emergency), retry the exit
          if (decision.trigger !== 'NONE') {
            console.log('[exit][checkPendingExits][retrying]', JSON.stringify({
              trade_id: trade.id,
              symbol: trade.symbol,
              trigger: decision.trigger,
              current_mark: decision.metrics.current_mark,
              note: 'Re-triggering exit with wider slippage due to timeout',
            }));
            
            // CRITICAL: Cancel ALL open close orders for these positions FIRST
            // Get option symbols to identify which orders to cancel
            const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
            const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
            const shortOption = optionChain.find(
              opt => opt.strike === trade.short_strike && opt.type === optionType
            );
            const longOption = optionChain.find(
              opt => opt.strike === trade.long_strike && opt.type === optionType
            );
            
            if (shortOption && longOption) {
              console.log('[exit][checkPendingExits][cancelling-all-close-orders-retry]', JSON.stringify({
                trade_id: trade.id,
                short_option_symbol: shortOption.symbol,
                long_option_symbol: longOption.symbol,
                note: 'Cancelling ALL open close orders for these positions before retry',
              }));
              
              const cancelledCount = await cancelOpenCloseOrders(
                broker,
                shortOption.symbol,
                longOption.symbol
              );
              
              console.log('[exit][checkPendingExits][cancelled-close-orders-retry]', JSON.stringify({
                trade_id: trade.id,
                cancelled_count: cancelledCount,
                note: 'Cancelled all open close orders - waiting before retry',
              }));
              
              // Wait for cancellations to process
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              // Fallback: try to cancel the specific order we know about
              try {
                console.log('[exit][checkPendingExits][cancelling-old-order-fallback]', JSON.stringify({
                trade_id: trade.id,
                order_id: trade.broker_order_id_close,
                order_status: order.status,
                  note: 'Cannot find option symbols - cancelling known order only',
              }));
              await broker.cancelOrder(trade.broker_order_id_close!);
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (err) {
              console.warn('[exit][checkPendingExits][cancel-failed]', JSON.stringify({
                trade_id: trade.id,
                order_id: trade.broker_order_id_close,
                error: err instanceof Error ? err.message : String(err),
                  note: 'Failed to cancel - executeExitForTrade will handle via cancelOpenCloseOrders',
              }));
              }
            }
            
            // Reset trade status to OPEN so it can be re-evaluated
            // Clear broker_order_id_close so executeExitForTrade doesn't think we already have an active order
            await updateTrade(env, trade.id, {
              status: 'OPEN',
              broker_order_id_close: null, // Clear the old order ID
            });
            
            console.log('[exit][checkPendingExits][triggering-retry]', JSON.stringify({
              trade_id: trade.id,
              symbol: trade.symbol,
              trigger: decision.trigger,
              current_mark: decision.metrics.current_mark,
              note: 'Calling executeExitForTrade to place new order with wider slippage (retry logic)',
            }));
            
            // Now trigger exit again - executeExitForTrade will:
            // 1. Call cancelOpenCloseOrders (line 481) to cancel any remaining open orders for these positions
            // 2. Place new order with wider slippage (via retryExit logic if needed)
            const retryResult = await executeExitForTrade(env, { ...trade, status: 'OPEN', broker_order_id_close: null }, decision, now);
            
            if (retryResult.success) {
              console.log('[exit][checkPendingExits][retry-success]', JSON.stringify({
                trade_id: trade.id,
                symbol: trade.symbol,
                note: 'Retry exit order placed successfully',
              }));
            } else {
              console.error('[exit][checkPendingExits][retry-failed]', JSON.stringify({
                trade_id: trade.id,
                symbol: trade.symbol,
                reason: retryResult.reason,
                note: 'Retry exit failed',
              }));
            }
          } else {
            // No exit trigger anymore - trade may have recovered
            // Reset to OPEN so monitoring can continue
            console.log('[exit][checkPendingExits][no-trigger]', JSON.stringify({
              trade_id: trade.id,
              symbol: trade.symbol,
              note: 'Order timed out but no exit trigger - resetting to OPEN for continued monitoring',
            }));
            
            await updateTrade(env, trade.id, {
              status: 'OPEN',
              broker_order_id_close: null,
            });
          }
        } else {
          // Still within timeout window - continue waiting
          console.log('[exit][checkPendingExits][waiting-within-timeout]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            order_age_ms: orderAge,
            timeout_ms: TIMEOUT_MS,
            remaining_ms: TIMEOUT_MS - orderAge,
            note: 'Order still within timeout window - continuing to wait',
          }));
        }
        continue;
      } else if (order.status === 'UNKNOWN') {
        // UNKNOWN status means we couldn't map Tradier's status
        // Treat it as potentially problematic - check if it's been pending long enough to retry
        console.warn('[exit][checkPendingExits][unknown-status-order]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_close,
          order_status: order.status,
          order_created_at: order.created_at || 'unknown',
          trade_updated_at: trade.updated_at,
          note: 'Order has UNKNOWN status - checking if should retry',
        }));
        
        // Use order creation time from Tradier API - try multiple fields
        const orderCreatedAtStr = order.created_at 
          || orderDetails?.created_at 
          || orderDetails?.create_date
          || trade.updated_at 
          || trade.opened_at 
          || trade.created_at 
          || now.toISOString();
        const orderCreatedAt = new Date(orderCreatedAtStr);
        const orderAge = now.getTime() - orderCreatedAt.getTime();
        const TIMEOUT_MS = 20 * 1000; // 20 seconds
        
        // If UNKNOWN order has been around for > timeout, treat it as timed out and retry
        if (orderAge > TIMEOUT_MS) {
          console.log('[exit][checkPendingExits][unknown-status-timeout]', JSON.stringify({
            trade_id: trade.id,
            order_id: trade.broker_order_id_close,
            order_age_ms: orderAge,
            timeout_ms: TIMEOUT_MS,
            note: 'UNKNOWN status order has been pending > timeout - treating as timed out and retrying',
          }));
          
          // Cancel the old order first
          try {
            await broker.cancelOrder(trade.broker_order_id_close!);
            console.log('[exit][checkPendingExits][cancelled-unknown-order]', JSON.stringify({
              trade_id: trade.id,
              cancelled_order_id: trade.broker_order_id_close,
            }));
          } catch (err) {
            console.warn('[exit][checkPendingExits][cancel-unknown-failed]', JSON.stringify({
              trade_id: trade.id,
              order_id: trade.broker_order_id_close,
              error: err instanceof Error ? err.message : String(err),
              note: 'Failed to cancel UNKNOWN order - proceeding with retry anyway',
            }));
          }
          
          // Wait briefly for cancellation to process
          await new Promise(resolve => setTimeout(resolve, 1500));
          
          // Re-evaluate and retry
          const { evaluateOpenTrade } = await import('./monitoring');
          const decision = await evaluateOpenTrade(env, trade, now);
          
          if (decision.trigger !== 'NONE') {
            // Reset trade to OPEN and clear order ID
            await updateTrade(env, trade.id, {
              status: 'OPEN',
              broker_order_id_close: null,
            });
            
            // Trigger retry
            await executeExitForTrade(env, { ...trade, status: 'OPEN', broker_order_id_close: null }, decision, now);
          } else {
            // No trigger - reset to OPEN
            await updateTrade(env, trade.id, {
              status: 'OPEN',
              broker_order_id_close: null,
            });
          }
        } else {
          console.log('[exit][checkPendingExits][unknown-status-waiting]', JSON.stringify({
            trade_id: trade.id,
            order_id: trade.broker_order_id_close,
            order_age_ms: orderAge,
            timeout_ms: TIMEOUT_MS,
            note: 'UNKNOWN status order still within timeout window - continuing to wait',
          }));
        }
      } else {
        // Other unexpected status - log it
        console.warn('[exit][checkPendingExits][unexpected-order-status]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_close,
          order_status: order.status,
          note: 'Order has unexpected status - continuing to monitor',
        }));
      }
    } catch (error) {
      // Broker error - log but continue (might be transient)
      console.error('[exit][checkPendingExits][error]', JSON.stringify({
        trade_id: trade.id,
        order_id: trade.broker_order_id_close,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        note: 'Failed to check order status from Tradier - will retry on next cycle',
      }));
    }
  }
  
  console.log('[exit][checkPendingExits][complete]', JSON.stringify({
    timestamp: now.toISOString(),
    processed_count: pendingTrades.length,
  }));
}

/**
 * Retry exit with fresh quantity check after quantity mismatch rejection
 */
async function retryExitWithFreshQuantities(
  env: Env,
  broker: TradierClient,
  trade: TradeRow,
  shortOptionSymbol: string,
  longOptionSymbol: string,
  decision: MonitoringDecision,
  now: Date
): Promise<ExitExecutionResult> {
  console.log('[exit][retry-fresh-quantities]', JSON.stringify({
    trade_id: trade.id,
    symbol: trade.symbol,
    timestamp: now.toISOString(),
  }));
  
  try {
    // Cancel any open orders again
    await cancelOpenCloseOrders(broker, shortOptionSymbol, longOptionSymbol);
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Recompute quantities from fresh positions
    // CRITICAL: Exit orders use portfolio position quantities, NOT trade.quantity
    const quantities = await computeAvailableQuantities(
      env,
      broker,
      trade,
      shortOptionSymbol,
      longOptionSymbol,
      9999 // Large number to get full available quantity from portfolio
    );
    
      // Check if already flat
      if (quantities.shortQtyToClose === 0 && quantities.longQtyToClose === 0) {
        // Use canonical handler that preserves original trigger and tries to get real exit_price
        // Need to get option symbols for gain/loss lookup
        const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
        const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
        const shortOption = optionChain.find(
          opt => opt.strike === trade.short_strike && opt.type === optionType
        );
        const longOption = optionChain.find(
          opt => opt.strike === trade.long_strike && opt.type === optionType
        );
        
        if (!shortOption || !longOption) {
          // Can't get option symbols - fall back to null exit_price
          const exitReason = mapTriggerToExitReason(decision.trigger);
          const closedTrade = await markTradeClosedWithReason(
            env,
            trade.id,
            null,
            now,
            exitReason,
            null
          );
          await recordTradeClosed(env, closedTrade);
          return {
            trade: closedTrade,
            trigger: decision.trigger,
            success: true,
          };
        }
        
        const closedTrade = await handleAlreadyFlat(
          env,
          broker,
          trade,
          decision,
          shortOption.symbol,
          longOption.symbol,
          now
        );
        
        return {
          trade: closedTrade,
          trigger: decision.trigger,
          success: true,
        };
      }
    
    // Get option chain to build legs
    // Defensive check: strategy should be set by entry engine
    if (!trade.strategy) {
      throw new Error(`Trade ${trade.id} missing strategy field - cannot determine option type for single-leg fallback`);
    }
    const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
    const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
    const shortOption = optionChain.find(
      opt => opt.strike === trade.short_strike && opt.type === optionType
    );
    const longOption = optionChain.find(
      opt => opt.strike === trade.long_strike && opt.type === optionType
    );
    
    if (!shortOption || !longOption) {
      throw new Error(`Cannot find ${optionType} option legs for retry exit`);
    }
    
    const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
    let leg0: SpreadLeg;
    let leg1: SpreadLeg;
    
    if (isDebitSpread) {
      leg0 = {
        option_symbol: longOption.symbol,
        side: 'sell_to_close' as const,
        quantity: quantities.longQtyToClose,
      };
      leg1 = {
        option_symbol: shortOption.symbol,
        side: 'buy_to_close' as const,
        quantity: quantities.shortQtyToClose,
      };
    } else {
      leg0 = {
        option_symbol: shortOption.symbol,
        side: 'buy_to_close' as const,
        quantity: quantities.shortQtyToClose,
      };
      leg1 = {
        option_symbol: longOption.symbol,
        side: 'sell_to_close' as const,
        quantity: quantities.longQtyToClose,
      };
    }
    
    // Place new order with fresh quantities
    // For multileg orders, Tradier requires type=credit or type=debit (not market)
    // We need to compute a limit price for the retry
    const retryLimitPrice = trade.width - (trade.entry_price || 0) + 0.20; // Protective price
    const order = await broker.placeSpreadOrder({
      symbol: trade.symbol,
      side: 'EXIT',
      legs: [leg0, leg1],
      tag: 'GEKKOWORKS-EXIT-RETRY-QUANTITY',
      strategy: trade.strategy,
      limit_price: retryLimitPrice,
    });
    
    // Check if it was rejected again
    const orderStatus = await broker.getOrder(order.id);
    const orderDetails = await broker.getOrderWithLegs(order.id);
    
    if (orderStatus.status === 'REJECTED' && isQuantityMismatchRejection(orderDetails)) {
      // Still quantity mismatch - mark as error and stop
      console.error('[exit][retry-fresh][still-mismatch]', JSON.stringify({
        trade_id: trade.id,
        order_id: order.id,
        timestamp: now.toISOString(),
      }));
      
      // Update trade once with both status and exit_reason
      const errorTrade = await updateTrade(env, trade.id, {
        status: 'EXIT_ERROR',
        exit_reason: 'QUANTITY_MISMATCH',
      });
      
      return {
        trade: errorTrade,
        trigger: decision.trigger,
        success: false,
        reason: 'Quantity mismatch persists after retry - manual intervention required',
      };
    }
    
    // Order accepted - poll for fill
    const fillResult = await pollForExitFill(broker, trade, order.id, now);
    
    if (fillResult.filled && fillResult.fillPrice !== undefined) {
      // Get exit_reason from decision trigger
      const exitReason = mapTriggerToExitReason(decision.trigger);
      const closedTrade = await markTradeClosedWithReason(
        env,
        trade.id,
        fillResult.fillPrice,
        new Date(),
        exitReason
      );
      await recordTradeClosed(env, closedTrade);
      
      if (decision.trigger === 'EMERGENCY') {
        await incrementEmergencyExitCount(env, now);
      }
      
      // Re-sync from Tradier
      const { syncPortfolioFromTradier } = await import('./portfolioSync');
      const { syncOrdersFromTradier } = await import('./orderSync');
      const { syncBalancesFromTradier } = await import('./balancesSync');
      
      await syncPortfolioFromTradier(env);
      await syncOrdersFromTradier(env);
      await syncBalancesFromTradier(env);
      
      return {
        trade: closedTrade,
        trigger: decision.trigger,
        success: true,
      };
    } else {
      return {
        trade,
        trigger: decision.trigger,
        success: false,
        reason: 'Retry order did not fill',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[exit][retry-fresh][error]', JSON.stringify({
      trade_id: trade.id,
      error: errorMessage,
      timestamp: now.toISOString(),
    }));
    
    return {
      trade,
      trigger: decision.trigger,
      success: false,
      reason: `Retry failed: ${errorMessage}`,
    };
  }
}

/**
 * Try single-leg fallback orders if multileg fails
 * 
 * Per Tradier spec: Submit two single-leg close orders, each as class=option
 * 
 * IMPORTANT: If only one leg fills, we leave the trade OPEN and rely on monitoring + manual intervention.
 * The next monitor tick will see legs out of sync (SPREAD_LEGS_OUT_OF_SYNC) and log a warning,
 * leaving the trade OPEN for manual cleanup. This is intentional - we don't try to "fix" partial fills
 * automatically as that could lead to unintended position changes.
 */
async function trySingleLegFallback(
  env: Env,
  broker: TradierClient,
  trade: TradeRow,
  leg0: SpreadLeg,
  leg1: SpreadLeg,
  decision: MonitoringDecision,
  now: Date
): Promise<ExitExecutionResult> {
  console.log('[exit][fallback][single-leg]', JSON.stringify({
    trade_id: trade.id,
    symbol: trade.symbol,
    leg0: { option_symbol: leg0.option_symbol, side: leg0.side, quantity: leg0.quantity },
    leg1: { option_symbol: leg1.option_symbol, side: leg1.side, quantity: leg1.quantity },
    timestamp: now.toISOString(),
  }));

  try {
    // Place two single-leg market orders
    const order0 = await broker.placeSingleLegCloseOrder({
      symbol: trade.symbol,
      option_symbol: leg0.option_symbol,
      side: leg0.side as 'buy_to_close' | 'sell_to_close',
      quantity: leg0.quantity,
      tag: 'GEKKOWORKS-EXIT-FALLBACK-0',
    });

    const order1 = await broker.placeSingleLegCloseOrder({
      symbol: trade.symbol,
      option_symbol: leg1.option_symbol,
      side: leg1.side as 'buy_to_close' | 'sell_to_close',
      quantity: leg1.quantity,
      tag: 'GEKKOWORKS-EXIT-FALLBACK-1',
    });

    console.log('[exit][fallback][orders-placed]', JSON.stringify({
      trade_id: trade.id,
      order0_id: order0.id,
      order1_id: order1.id,
      timestamp: now.toISOString(),
    }));

    // Check initial status of both orders
    let order0Status = await broker.getOrder(order0.id);
    let order1Status = await broker.getOrder(order1.id);
    
    console.log('[exit][fallback][initial-status]', JSON.stringify({
      trade_id: trade.id,
      order0_id: order0.id,
      order0_status: order0Status.status,
      order1_id: order1.id,
      order1_status: order1Status.status,
      timestamp: now.toISOString(),
    }));

    // If either order was immediately rejected, log and return failure
    if (order0Status.status === 'REJECTED' || order1Status.status === 'REJECTED') {
      return {
        trade,
        trigger: decision.trigger,
        success: false,
        reason: `Single-leg fallback rejected: order0=${order0Status.status}, order1=${order1Status.status}`,
      };
    }

    // Poll both orders for fills (wait up to 20 seconds each)
    const fill0 = await pollForExitFill(broker, trade, order0.id, now);
    const fill1 = await pollForExitFill(broker, trade, order1.id, now);

    console.log('[exit][fallback][poll-results]', JSON.stringify({
      trade_id: trade.id,
      order0_id: order0.id,
      order0_filled: fill0.filled,
      order0_fillPrice: fill0.fillPrice,
      order1_id: order1.id,
      order1_filled: fill1.filled,
      order1_fillPrice: fill1.fillPrice,
      timestamp: now.toISOString(),
    }));

    if (fill0.filled && fill1.filled) {
      // Both legs filled - use average of fill prices
      const avgFillPrice = fill0.fillPrice && fill1.fillPrice
        ? (fill0.fillPrice + fill1.fillPrice) / 2
        : fill0.fillPrice || fill1.fillPrice || 0;

      if (avgFillPrice > 0) {
        // Get exit_reason from decision trigger
        const exitReason = mapTriggerToExitReason(decision.trigger);
        const closedTrade = await markTradeClosedWithReason(
          env,
          trade.id,
          avgFillPrice,
          new Date(),
          exitReason
        );

        await recordTradeClosed(env, closedTrade);

        if (decision.trigger === 'EMERGENCY') {
          await incrementEmergencyExitCount(env, now);
        }

        // Re-sync from Tradier after closing
        const { syncPortfolioFromTradier } = await import('./portfolioSync');
        const { syncOrdersFromTradier } = await import('./orderSync');
        const { syncBalancesFromTradier } = await import('./balancesSync');

        await syncPortfolioFromTradier(env);
        await syncOrdersFromTradier(env);
        await syncBalancesFromTradier(env);

        return {
          trade: closedTrade,
          trigger: decision.trigger,
          success: true,
        };
      }
    }

    // One or both orders didn't fill - check final status
    const finalOrder0Status = await broker.getOrder(order0.id);
    const finalOrder1Status = await broker.getOrder(order1.id);
    
    console.log('[exit][fallback][final-status]', JSON.stringify({
      trade_id: trade.id,
      order0_id: order0.id,
      order0_status: finalOrder0Status.status,
      order0_filled_qty: finalOrder0Status.filled_quantity,
      order1_id: order1.id,
      order1_status: finalOrder1Status.status,
      order1_filled_qty: finalOrder1Status.filled_quantity,
      timestamp: now.toISOString(),
    }));

    // One or both orders didn't fill
    return {
      trade,
      trigger: decision.trigger,
      success: false,
      reason: `Single-leg fallback: order0 filled=${fill0.filled} (status=${finalOrder0Status.status}), order1 filled=${fill1.filled} (status=${finalOrder1Status.status})`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[exit][fallback][error]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      error: errorMessage,
      timestamp: now.toISOString(),
    }));

    return {
      trade,
      trigger: decision.trigger,
      success: false,
      reason: `Single-leg fallback failed: ${errorMessage}`,
    };
  }
}

/**
 * Poll for exit fill
 */
async function pollForExitFill(
  broker: TradierClient,
  trade: TradeRow,
  orderId: string,
  startTime: Date
): Promise<{ filled: boolean; fillPrice?: number }> {
  const maxWaitTime = startTime.getTime() + MAX_FILL_WAIT_MS;
  
  while (Date.now() < maxWaitTime) {
    const order = await broker.getOrder(orderId);
    
    // Log order status for debugging
    console.log('[exit][poll][status]', JSON.stringify({
      trade_id: trade.id,
      order_id: orderId,
      status: order.status,
      filled_quantity: order.filled_quantity,
      remaining_quantity: order.remaining_quantity,
      avg_fill_price: order.avg_fill_price,
      elapsed_ms: Date.now() - startTime.getTime(),
    }));
    
    if (order.status === 'FILLED') {
      if (order.avg_fill_price !== null) {
        return { filled: true, fillPrice: order.avg_fill_price };
      } else {
        // Data error - treat as not filled, will retry
        return { filled: false };
      }
    }
    
    if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
      console.log('[exit][poll][rejected]', JSON.stringify({
        trade_id: trade.id,
        order_id: orderId,
        status: order.status,
        reason: 'Order was cancelled or rejected by broker',
      }));
      return { filled: false };
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  
  // Timeout
  return { filled: false };
}

/**
 * Retry exit with wider slippage
 */
async function retryExit(
  env: Env,
  broker: TradierClient,
  trade: TradeRow,
  decision: MonitoringDecision,
  now: Date
): Promise<ExitExecutionResult> {
  try {
    // Compute retry limit price
    let closeLimit: number;
    
    if (decision.metrics.current_mark > 0 && decision.metrics.quote_integrity_ok) {
      closeLimit = decision.metrics.current_mark + CLOSE_RETRY_SLIPPAGE;
    } else {
      if (!trade.entry_price) {
        throw new Error('Trade has no entry_price for retry exit');
      }
      // Emergency exit pricing: accept up to (max_loss + CLOSE_EMERGENCY_SLIPPAGE) to guarantee flattening
      // For credit spreads: max_loss = width - entry_price
      // For debit spreads: max_loss = entry_price
      // See comment in executeExitForTrade for full policy documentation
      const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
      if (isDebitSpread) {
        closeLimit = trade.entry_price + CLOSE_EMERGENCY_SLIPPAGE; // Debit: max_loss = entry_price
      } else {
        closeLimit = trade.width - trade.entry_price + CLOSE_EMERGENCY_SLIPPAGE; // Credit: max_loss = width - entry_price
      }
    }
    
    // Get option symbols (determine type based on strategy)
    const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
    const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
    const shortOption = optionChain.find(
      opt => opt.strike === trade.short_strike && opt.type === optionType
    );
    const longOption = optionChain.find(
      opt => opt.strike === trade.long_strike && opt.type === optionType
    );
    
    if (!shortOption || !longOption) {
      throw new Error(`Cannot find ${optionType} option legs for retry exit`);
    }
    
    const retryQuantity = await resolveExitQuantity(
      env,
      broker,
      trade,
      shortOption.symbol,
      longOption.symbol
    );
    if (!retryQuantity.success) {
        // Handle positions already flat cases from resolveExitQuantity
        if (retryQuantity.reason === 'ALREADY_CLOSED_VIA_ORDER') {
          // Positions are flat but we have a close order - order sync should capture exit_price
          // Don't try to close again, just log and wait for order sync
          console.log('[exit][already-closed-via-order]', JSON.stringify({
            trade_id: trade.id,
            broker_order_id_close: trade.broker_order_id_close,
            note: 'Positions already flat with close order - order sync should capture exit_price',
          }));
          return {
            trade,
            trigger: decision.trigger,
            success: false,
            reason: 'Positions already closed via order - waiting for order sync to capture exit_price',
          };
        } else if (retryQuantity.reason === 'POSITIONS_FLAT_NO_ORDER') {
          // Positions are flat but no close order - unexpected, needs investigation
          console.warn('[exit][positions-flat-no-order]', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            note: 'WARNING: Positions are flat but no close order - positions may have been closed externally',
            recommendation: 'Investigate - trade left OPEN',
          }));
          return {
            trade,
            trigger: decision.trigger,
            success: false,
            reason: 'Positions flat but no close order - needs investigation',
          };
        } else if (retryQuantity.reason === 'BROKER_ALREADY_FLAT') {
          // Legacy case - use canonical handler
          const closedTrade = await handleAlreadyFlat(
            env,
            broker,
            trade,
            decision,
            shortOption.symbol,
            longOption.symbol,
            now
          );
          return {
            trade: closedTrade,
            trigger: decision.trigger,
            success: true,
          };
        }
      return {
        trade,
        trigger: decision.trigger,
        success: false,
        reason: retryQuantity.reason,
      };
    }
    // Use updated trade from resolveExitQuantity (may have adjusted quantity)
    let workingTrade = retryQuantity.trade;
    const quantity = retryQuantity.quantity;
    
    // Determine leg sides and order based on strategy (same logic as initial exit)
    const isDebitSpread = workingTrade.strategy === 'BULL_CALL_DEBIT' || workingTrade.strategy === 'BEAR_PUT_DEBIT';
    let leg0: SpreadLeg;
    let leg1: SpreadLeg;
    
    if (isDebitSpread) {
      leg0 = {
        option_symbol: longOption.symbol,
        side: 'sell_to_close' as const,
        quantity: quantity,
      };
      leg1 = {
        option_symbol: shortOption.symbol,
        side: 'buy_to_close' as const,
        quantity: quantity,
      };
    } else {
      leg0 = {
        option_symbol: shortOption.symbol,
        side: 'buy_to_close' as const,
        quantity: quantity,
      };
      leg1 = {
        option_symbol: longOption.symbol,
        side: 'sell_to_close' as const,
        quantity: quantity,
      };
    }
    
    console.log('[exit][retry]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      trade_quantity: trade.quantity,
      default_quantity: trade.quantity ?? (await getDefaultTradeQuantity(env)),
      using_quantity: quantity,
      option_type: optionType,
      strategy: trade.strategy,
      is_debit_spread: isDebitSpread,
      retry_limit_price: closeLimit,
      current_mark: decision.metrics.current_mark,
      leg0: { option_symbol: leg0.option_symbol, side: leg0.side, quantity: leg0.quantity },
      leg1: { option_symbol: leg1.option_symbol, side: leg1.side, quantity: leg1.quantity },
      note: 'Retry attempt with widened slippage (CLOSE_RETRY_SLIPPAGE)',
      timestamp: now.toISOString(),
    }));
    // For multileg orders, Tradier requires type=credit or type=debit (not market)
    // Use the computed retry limit price
    const order = await broker.placeSpreadOrder({
      symbol: trade.symbol,
      side: 'EXIT',
      legs: [leg0, leg1],
      tag: 'GEKKOWORKS-EXIT-RETRY',
      strategy: trade.strategy,
      limit_price: closeLimit,
    });
    
    // Poll for fill
    console.log('[exit][retry][polling]', JSON.stringify({
      trade_id: trade.id,
      retry_order_id: order.id,
      retry_limit_price: closeLimit,
      note: 'Polling for retry order fill (20 second timeout)',
    }));
    
    const fillResult = await pollForExitFill(broker, trade, order.id, now);
    
    if (fillResult.filled && fillResult.fillPrice !== undefined) {
      console.log('[exit][retry][filled]', JSON.stringify({
        trade_id: trade.id,
        retry_order_id: order.id,
        fill_price: fillResult.fillPrice,
        note: 'Retry order filled successfully',
      }));
      
      // Get exit_reason from decision trigger
      const exitReason = mapTriggerToExitReason(decision.trigger);
      const closedTrade = await markTradeClosedWithReason(
        env,
        trade.id,
        fillResult.fillPrice,
        new Date(),
        exitReason
      );
      
      await recordTradeClosed(env, closedTrade);
      
      // Track emergency exits after we actually close the trade
      if (decision.trigger === 'EMERGENCY') {
        await incrementEmergencyExitCount(env, now);
      }
      
      return {
        trade: closedTrade,
        trigger: decision.trigger,
        success: true,
      };
    } else {
      console.log('[exit][retry][failed][final-attempt]', JSON.stringify({
        trade_id: trade.id,
        retry_order_id: order.id,
        retry_order_status: (await broker.getOrder(order.id)).status,
        note: 'Retry order did not fill - attempting final emergency close with max slippage',
      }));
      
      // Final emergency close with widened limit
      if (!workingTrade.entry_price) {
        throw new Error('Trade has no entry_price for final emergency close');
      }
      // Emergency exit pricing: accept up to (max_loss + CLOSE_EMERGENCY_SLIPPAGE) to guarantee flattening
      // For credit spreads: max_loss = width - entry_price
      // For debit spreads: max_loss = entry_price
      const isDebitSpreadForFinal = workingTrade.strategy === 'BULL_CALL_DEBIT' || workingTrade.strategy === 'BEAR_PUT_DEBIT';
      const finalCloseLimit = isDebitSpreadForFinal
        ? workingTrade.entry_price + CLOSE_EMERGENCY_SLIPPAGE // Debit: max_loss = entry_price
        : workingTrade.width - workingTrade.entry_price + CLOSE_EMERGENCY_SLIPPAGE; // Credit: max_loss = width - entry_price
      
      console.log('[exit][retry][final-limit-attempt]', JSON.stringify({
        trade_id: workingTrade.id,
        symbol: workingTrade.symbol,
        final_close_limit: finalCloseLimit,
        entry_price: workingTrade.entry_price,
        width: workingTrade.width,
        is_debit: isDebitSpreadForFinal,
        note: 'Attempting final limit order with widened slippage before market order fallback',
      }));
      
      const finalQuantity = await resolveExitQuantity(
        env,
        broker,
        workingTrade,
        shortOption.symbol,
        longOption.symbol
      );
      if (!finalQuantity.success) {
        // Handle positions already flat cases
        if (finalQuantity.reason === 'ALREADY_CLOSED_VIA_ORDER') {
          // Positions are flat but we have a close order - order sync should capture exit_price
          console.log('[exit][retry][already-closed-via-order]', JSON.stringify({
            trade_id: workingTrade.id,
            broker_order_id_close: workingTrade.broker_order_id_close,
            note: 'Positions already flat with close order - order sync should capture exit_price',
          }));
          return {
            trade: workingTrade,
            trigger: decision.trigger,
            success: false,
            reason: 'Positions already closed via order - waiting for order sync to capture exit_price',
          };
        } else if (finalQuantity.reason === 'POSITIONS_FLAT_NO_ORDER') {
          // Positions are flat but no close order - unexpected, needs investigation
          console.warn('[exit][retry][positions-flat-no-order]', JSON.stringify({
            trade_id: workingTrade.id,
            symbol: workingTrade.symbol,
            note: 'WARNING: Positions are flat but no close order - positions may have been closed externally',
            recommendation: 'Investigate - trade left OPEN',
          }));
          return {
            trade: workingTrade,
            trigger: decision.trigger,
            success: false,
            reason: 'Positions flat but no close order - needs investigation',
          };
        } else if (finalQuantity.reason === 'BROKER_ALREADY_FLAT') {
          // Legacy case - use canonical handler
          const closedTrade = await handleAlreadyFlat(
            env,
            broker,
            workingTrade,
            decision,
            shortOption.symbol,
            longOption.symbol,
            now
          );
          return {
            trade: closedTrade,
            trigger: decision.trigger,
            success: true,
          };
        }
        await markTradeCancelled(env, workingTrade.id, finalQuantity.reason || 'Exit failed');
        return {
          trade: workingTrade,
          trigger: decision.trigger,
          success: false,
          reason: finalQuantity.reason || 'Exit failed after all retries',
        };
      }
      // Update working trade with final quantity adjustments
      workingTrade = finalQuantity.trade;
      const finalQuantityValue = finalQuantity.quantity;
      
      // Determine leg sides and order based on strategy (same logic as initial exit)
      const isDebitSpreadFinal = workingTrade.strategy === 'BULL_CALL_DEBIT' || workingTrade.strategy === 'BEAR_PUT_DEBIT';
      let leg0Final: SpreadLeg;
      let leg1Final: SpreadLeg;
      
      if (isDebitSpreadFinal) {
        leg0Final = {
          option_symbol: longOption.symbol,
          side: 'sell_to_close' as const,
          quantity: finalQuantityValue,
        };
        leg1Final = {
          option_symbol: shortOption.symbol,
          side: 'buy_to_close' as const,
          quantity: finalQuantityValue,
        };
      } else {
        leg0Final = {
          option_symbol: shortOption.symbol,
          side: 'buy_to_close' as const,
          quantity: finalQuantityValue,
        };
        leg1Final = {
          option_symbol: longOption.symbol,
          side: 'sell_to_close' as const,
          quantity: finalQuantityValue,
        };
      }
      
      console.log('[exit][final]', JSON.stringify({
        trade_id: workingTrade.id,
        trade_quantity: workingTrade.quantity,
        default_quantity: workingTrade.quantity ?? (await getDefaultTradeQuantity(env)),
        using_quantity: finalQuantityValue,
        option_type: optionType,
        strategy: workingTrade.strategy,
        is_debit_spread: isDebitSpreadFinal,
        leg0: { option_symbol: leg0Final.option_symbol, side: leg0Final.side },
        leg1: { option_symbol: leg1Final.option_symbol, side: leg1Final.side },
        timestamp: now.toISOString(),
      }));
      
      // For multileg orders, Tradier requires type=credit or type=debit (not market)
      // Use the computed final limit price
      const finalOrder = await broker.placeSpreadOrder({
        symbol: workingTrade.symbol,
        side: 'EXIT',
        legs: [leg0Final, leg1Final],
        tag: 'GEKKOWORKS-EXIT-FINAL',
        strategy: workingTrade.strategy,
        limit_price: finalCloseLimit,
      });
      
      const finalFill = await pollForExitFill(broker, workingTrade, finalOrder.id, now);
      
      if (finalFill.filled && finalFill.fillPrice !== undefined) {
        // Get exit_reason from decision trigger
        const exitReason = mapTriggerToExitReason(decision.trigger);
        const closedTrade = await markTradeClosedWithReason(
          env,
          workingTrade.id,
          finalFill.fillPrice,
          new Date(),
          exitReason
        );
        
        await recordTradeClosed(env, closedTrade);
        
        if (decision.trigger === 'EMERGENCY') {
          await incrementEmergencyExitCount(env, now);
        }
        
        return {
          trade: closedTrade,
          trigger: decision.trigger,
          success: true,
        };
      } else {
        // Final limit order failed - use market orders as last resort
        console.log('[exit][retry][final-limit-failed][using-market]', JSON.stringify({
          trade_id: workingTrade.id,
          symbol: workingTrade.symbol,
          final_order_id: finalOrder.id,
          final_order_status: (await broker.getOrder(finalOrder.id)).status,
          note: 'Final limit order did not fill - using market orders as last resort',
        }));
        
        // Cancel the final limit order
        try {
          await broker.cancelOrder(finalOrder.id);
        } catch (err) {
          // Ignore cancellation errors - order may have already filled or been cancelled
        }
        
        // Use market orders for each leg as absolute last resort
        // trySingleLegFallback already uses market orders, so we can reuse it
        return await trySingleLegFallback(env, broker, workingTrade, leg0Final, leg1Final, decision, now);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[exit][retry][error]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      error: errorMessage,
      timestamp: now.toISOString(),
    }));
    
    // Mark as CLOSE_FAILED
    await markTradeCancelled(env, trade.id, `Exit failed after all retries: ${errorMessage}`);
    
    return {
      trade,
      trigger: decision.trigger,
      success: false,
      reason: errorMessage,
    };
  }
}

async function resolveExitQuantity(
  env: Env,
  broker: TradierClient,
  trade: TradeRow,
  shortOptionSymbol: string,
  longOptionSymbol: string
): Promise<
  | { success: true; quantity: number; trade: TradeRow }
  | { success: false; reason: string }
> {
  // CRITICAL: Exit orders use portfolio position quantities, NOT trade.quantity
  // Multiple trades may share the same positions, so we close the actual portfolio position
  let updatedTrade = trade;
  
  // Determine option type from strategy
  if (!trade.strategy) {
    throw new Error(`Trade ${trade.id} missing strategy - cannot determine option type`);
  }
  const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
  
  // Get positions from portfolio_positions (primary source)
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
  const shortPosQty = snapshot.shortQty;
  const longPosQty = snapshot.longQty;
  
  // Log position snapshot
  console.log('[exit][position-snapshot]', JSON.stringify({
    source: 'resolveExitQuantity',
    trade_id: trade.id,
    symbol: trade.symbol,
    short_strike: trade.short_strike,
    long_strike: trade.long_strike,
    snapshot: {
      shortQty: snapshot.shortQty,
      longQty: snapshot.longQty,
    },
  }));
  
  // Account for open orders that are already trying to close these positions
  // This ensures we don't try to close more than is actually available
  const openOrders = await broker.getOpenOrders();
  let shortQtyInOpenOrders = 0;
  let longQtyInOpenOrders = 0;
  
  for (const order of openOrders) {
    if (order.status === 'OPEN' || order.status === 'NEW') {
      try {
        const orderDetails = await broker.getOrderWithLegs(order.id);
        const legs = orderDetails.leg || [];
        
        for (const leg of legs) {
          if (leg.option_symbol === shortOptionSymbol) {
            if (leg.side?.includes('buy_to_close')) {
              shortQtyInOpenOrders += leg.quantity || 0;
            }
          }
          if (leg.option_symbol === longOptionSymbol) {
            if (leg.side?.includes('sell_to_close')) {
              longQtyInOpenOrders += leg.quantity || 0;
            }
          }
        }
        
        // Also check single-leg option orders
        if (orderDetails.class === 'option') {
          const optionSymbol = orderDetails.option_symbol;
          const side = orderDetails.side || '';
          if (optionSymbol === shortOptionSymbol && side.includes('buy_to_close')) {
            shortQtyInOpenOrders += orderDetails.quantity || 0;
          }
          if (optionSymbol === longOptionSymbol && side.includes('sell_to_close')) {
            longQtyInOpenOrders += orderDetails.quantity || 0;
          }
        }
      } catch (err) {
        // If we can't get order details, skip it
        console.warn('[exit][resolveQuantity] failed to get order details', {
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  
  // Available quantity = position - already pending in open orders
  const availableShortQty = Math.max(0, shortPosQty - shortQtyInOpenOrders);
  const availableLongQty = Math.max(0, longPosQty - longQtyInOpenOrders);
  
  // Rule: If both legs are zero, check if we have a close order
  // CRITICAL: If positions are flat but we don't have a close order, this is unexpected
  // - If we have a close order: positions were closed by us, order sync should capture exit_price
  // - If we don't have a close order: positions were closed externally (shouldn't happen) or portfolio sync is wrong
  if (availableShortQty === 0 && availableLongQty === 0) {
    // Check if we have a close order - if so, this is expected
    if (trade.broker_order_id_close) {
      console.log('[exit][positions][already_flat][has-close-order]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        short_leg_symbol: shortOptionSymbol,
        long_leg_symbol: longOptionSymbol,
        broker_order_id_close: trade.broker_order_id_close,
        reason: 'Positions already flat but close order exists - order sync should capture exit_price',
      }));
      // Don't try to close again - order sync should handle exit_price
      return { success: false, reason: 'ALREADY_CLOSED_VIA_ORDER' };
    } else {
      // Positions are flat but no close order - this shouldn't happen if we're managing
      console.warn('[exit][positions][already_flat][no-close-order]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        short_leg_symbol: shortOptionSymbol,
        long_leg_symbol: longOptionSymbol,
        reason: 'WARNING: Positions are flat but no close order - positions may have been closed externally or portfolio sync is wrong',
        recommendation: 'Investigate - do not auto-close',
      }));
      // Don't auto-close - this needs investigation
      return { success: false, reason: 'POSITIONS_FLAT_NO_ORDER' };
    }
  }
  
  // Rule: If only one leg is missing, that's a data issue (SPREAD_LEGS_OUT_OF_SYNC)
  if (availableShortQty === 0 || availableLongQty === 0) {
    console.warn('[exit][positions][out-of-sync]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      short_leg_symbol: shortOptionSymbol,
      long_leg_symbol: longOptionSymbol,
      available_short_qty: availableShortQty,
      available_long_qty: availableLongQty,
      short_leg_found: !!shortLeg,
      long_leg_found: !!longLeg,
      snapshot: {
        shortQty: snapshot.shortQty,
        longQty: snapshot.longQty,
      },
    }));
    return { success: false, reason: 'SPREAD_LEGS_OUT_OF_SYNC' };
  }
  
  const availableQty = Math.min(availableShortQty, availableLongQty);
  if (availableQty <= 0) {
    console.warn('[exit][positions][empty]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      short_leg_symbol: shortOptionSymbol,
      long_leg_symbol: longOptionSymbol,
      available_short_qty: availableShortQty,
      available_long_qty: availableLongQty,
    }));
    return { success: false, reason: 'No open contracts to close' };
  }
  
  // CRITICAL: Use portfolio position quantity directly, not trade.quantity
  // Exit orders close the actual portfolio position, not what the trade record says
  const exitQuantity = availableQty;
  
  console.log('[exit][quantity][portfolio-based]', JSON.stringify({
    trade_id: trade.id,
    trade_quantity: trade.quantity,
    portfolio_short_qty: availableShortQty,
    portfolio_long_qty: availableLongQty,
    exit_quantity: exitQuantity,
    note: 'Exit order uses portfolio position quantity, not trade.quantity',
  }));
  
  return { success: true, quantity: exitQuantity, trade: updatedTrade };
}

/**
 * Map exit trigger type to exit reason
 * 
 * This is the canonical mapping function - all trigger-to-reason conversions should use this.
 * IV_CRUSH_EXIT and LOW_VALUE_CLOSE are profit-driven exits, so they map to PROFIT_TARGET.
 */
function mapTriggerToExitReason(trigger: ExitTriggerType): ExitReason {
  switch (trigger) {
    case 'PROFIT_TARGET':
    case 'TRAIL_PROFIT':
    case 'IV_CRUSH_EXIT':  // IV crush is profit-related (IV decreased, spread worth less to close)
    case 'LOW_VALUE_CLOSE': // Low value close is profit-related (spread worth very little)
      return 'PROFIT_TARGET';
    case 'STOP_LOSS':
      return 'STOP_LOSS';
    case 'TIME_EXIT':
      return 'TIME_EXIT';
    case 'EMERGENCY':
      return 'EMERGENCY';
    case 'NONE':
      return 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Handle "already flat" scenario - trade was opened but positions are already closed at broker
 * 
 * This is the canonical handler for all "already flat" cases. It:
 * - Tries to get real exit_price from Tradier gain/loss data
 * - Falls back to null if not found (no estimation/fabrication)
 * - Uses original monitoring trigger mapped to exit_reason (preserves "why we tried to close")
 * - Logs that positions were already flat as a detail, not the exit_reason
 * 
 * @param env Environment
 * @param broker TradierClient
 * @param trade Trade that's already flat
 * @param decision Original monitoring decision that triggered the exit attempt
 * @param shortOptionSymbol Short leg option symbol (for gain/loss lookup)
 * @param longOptionSymbol Long leg option symbol (for gain/loss lookup)
 * @param now Current timestamp
 * @returns Closed trade
 */
async function handleAlreadyFlat(
  env: Env,
  broker: TradierClient,
  trade: TradeRow,
  decision: MonitoringDecision,
  shortOptionSymbol: string,
  longOptionSymbol: string,
  now: Date
): Promise<TradeRow> {
  const originalTrigger = decision.trigger;
  const exitReason = mapTriggerToExitReason(originalTrigger);
  
  console.log('[exit][already-flat]', JSON.stringify({
    trade_id: trade.id,
    symbol: trade.symbol,
    strategy: trade.strategy,
    entry_price: trade.entry_price,
    broker_order_id_open: trade.broker_order_id_open,
    original_trigger: originalTrigger,
    exit_reason: exitReason,
    timestamp: now.toISOString(),
    note: `Trade was opened but positions already closed at broker. Original exit trigger: ${originalTrigger}`,
  }));
  
  // Try to get real exit_price from Tradier gain/loss data
  let actualExitPrice: number | null = null;
  
  if (trade.entry_price && trade.entry_price > 0) {
    try {
      // Get gain/loss data for the last 7 days to find the actual close
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
      const gainLossData = await broker.getGainLoss({
        start: startDate.toISOString().split('T')[0],
        end: now.toISOString().split('T')[0],
      });
      
      // Look for closed positions matching our option symbols
      const shortClose = gainLossData.find(p => p.symbol === shortOptionSymbol);
      const longClose = gainLossData.find(p => p.symbol === longOptionSymbol);
      
      if (shortClose && longClose) {
        const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
        const quantity = trade.quantity ?? 1;
        
        // Tradier's gain_loss is the total PnL for each position
        // For a spread, the net PnL is the sum of both legs' PnL
        // Divide by quantity to get per-contract PnL
        const totalPnL = (shortClose.gain_loss || 0) + (longClose.gain_loss || 0);
        const perContractPnL = totalPnL / quantity;
        
        // Reverse calculate exit_price from PnL
        // For credit: PnL = entry_price - exit_price, so exit_price = entry_price - PnL
        // For debit: PnL = exit_price - entry_price, so exit_price = entry_price + PnL
        if (isDebitSpread) {
          actualExitPrice = trade.entry_price + perContractPnL;
        } else {
          actualExitPrice = trade.entry_price - perContractPnL;
        }
        
        // Clamp to reasonable bounds (0 to width)
        actualExitPrice = Math.max(0, Math.min(trade.width, actualExitPrice));
        
        console.log('[exit][already-flat][calculated-close-price]', JSON.stringify({
          trade_id: trade.id,
          short_gain_loss: shortClose.gain_loss,
          long_gain_loss: longClose.gain_loss,
          total_pnl: totalPnL,
          per_contract_pnl: perContractPnL,
          calculated_exit_price: actualExitPrice,
        }));
      }
    } catch (error) {
      // If we can't get gain/loss data, log but continue (will use null)
      console.warn('[exit][already-flat][gain-loss-fetch-failed]', JSON.stringify({
        trade_id: trade.id,
        error: error instanceof Error ? error.message : String(error),
        note: 'Will use exit_price=null, realized_pnl=null',
      }));
    }
  }
  
  // Use calculated exit_price if found, otherwise null (no estimation/fabrication)
  // CRITICAL: Preserve original trigger as exit_reason (why we tried to close)
  // BROKER_ALREADY_FLAT is just a detail in logs, not the exit_reason
  const closedTrade = await markTradeClosedWithReason(
    env,
    trade.id,
    actualExitPrice, // null if we couldn't calculate from gain/loss
    now,
    exitReason, // Use original trigger mapped to exit_reason
    null // realized_pnl will be calculated by markTradeClosedWithReason if exitPrice is set, otherwise null
  );
  
  await recordTradeClosed(env, closedTrade);
  
  return closedTrade;
}

