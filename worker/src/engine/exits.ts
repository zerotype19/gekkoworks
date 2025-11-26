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
  MonitoringDecision,
  BrokerOrder,
  SpreadLeg,
} from '../types';
import { TradierClient } from '../broker/tradierClient';
import { markTradeClosingPending, markTradeClosed, markTradeCancelled } from './lifecycle';
import { recordTradeClosed, incrementEmergencyExitCount } from '../core/risk';
import { getTradingMode, getDefaultTradeQuantity } from '../core/config';
import { notifyExitSubmitted } from '../notifications/telegram';
import { updateTrade } from '../db/queries';

const CLOSE_SLIPPAGE = 0.02;
const CLOSE_RETRY_SLIPPAGE = 0.03;
const MAX_FILL_WAIT_MS = 20 * 1000; // 20 seconds
const POLL_INTERVAL_MS = 2 * 1000; // 2 seconds

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
 * Compute available quantities from Tradier positions
 * Returns quantities that can actually be closed, accounting for open orders
 */
async function computeAvailableQuantities(
  broker: TradierClient,
  shortOptionSymbol: string,
  longOptionSymbol: string,
  targetQuantity: number
): Promise<{
  shortQtyToClose: number;
  longQtyToClose: number;
  shortPosition: number;
  longPosition: number;
}> {
  // Get actual positions from Tradier
  const positions = await broker.getPositions();
  
  const shortPosition = positions.find(p => p.symbol === shortOptionSymbol);
  const longPosition = positions.find(p => p.symbol === longOptionSymbol);
  
  // Positions are negative for short, positive for long
  const shortPosQty = shortPosition ? Math.abs(shortPosition.quantity) : 0;
  const longPosQty = longPosition ? Math.abs(longPosition.quantity) : 0;
  
  // Get open orders that might be closing these positions
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
  
  console.log('[exit][computeQuantities]', JSON.stringify({
    shortOptionSymbol,
    longOptionSymbol,
    targetQuantity,
    shortPosQty,
    longPosQty,
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
    
    // Get current mark for limit price calculation
    let closeLimit: number;
    
    if (decision.metrics.current_mark > 0 && decision.metrics.quote_integrity_ok) {
      // Normal exit - use mark + slippage
      closeLimit = decision.metrics.current_mark + CLOSE_SLIPPAGE;
    } else {
      // Emergency exit - use protective price
      if (!trade.entry_price || trade.entry_price <= 0) {
        console.error('[exit][error]', JSON.stringify({
          trade_id: trade.id,
          reason: 'Trade has no entry_price for emergency exit',
        }));
      // For emergency exits without entry_price, use width + buffer as fallback
      // This is a last resort - should not happen for managed trades
      // We deliberately over-pay (width + buffer) to guarantee flattening when we don't know entry
      closeLimit = trade.width + 0.20; // Pay up to full width + buffer if we truly don't know entry
        console.warn('[exit][fallback-limit]', JSON.stringify({
          trade_id: trade.id,
          fallback_limit: closeLimit,
          width: trade.width,
        }));
      } else {
        // Emergency exit pricing: accept up to (max_loss + 0.20) to guarantee flattening
        // For credit spreads: width - entry_price ≈ max_loss per spread
        // This deliberately prioritizes "get out at any cost" over price optimization
        // See exit-rules.md for full policy documentation
        closeLimit = trade.width - trade.entry_price + 0.20;
      }
    }
    
    // Map exit trigger to exit reason
    const exitReason = mapTriggerToExitReason(decision.trigger);
    
    // Check trading mode
    const tradingMode = await getTradingMode(env);
    
    if (tradingMode === 'DRY_RUN') {
      // DRY_RUN mode - log but do not place order
      console.log(`[DRY_RUN] Would place exit order:`, {
        trade_id: trade.id,
        trigger: decision.trigger,
        exit_reason: exitReason,
        close_limit: closeLimit,
      });
      
      // In DRY_RUN, we don't actually close - just log
      return {
        trade,
        trigger: decision.trigger,
        success: false,
        reason: 'DRY_RUN mode - exit order not placed',
      };
    }
    
    // Get option symbols (determine type based on strategy)
    // Defensive check: strategy should be set by entry engine, but handle gracefully if missing
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
    
    // STEP 2: Compute available quantities from Tradier positions
    const targetQuantity = trade.quantity ?? await getDefaultTradeQuantity(env);
    const quantities = await computeAvailableQuantities(
      broker,
      shortOption.symbol,
      longOption.symbol,
      targetQuantity
    );
    
    // STEP 3: Check if already flat at broker
    if (quantities.shortQtyToClose === 0 && quantities.longQtyToClose === 0) {
      console.log('[exit][already-flat]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        shortPosition: quantities.shortPosition,
        longPosition: quantities.longPosition,
        timestamp: now.toISOString(),
      }));
      
      // For BROKER_ALREADY_FLAT, we don't know the actual fill price.
      // Try to calculate it from Tradier's gain/loss data, or estimate it.
      let actualExitPrice: number | null = null;
      
      if (trade.entry_price) {
        try {
          // Get gain/loss data for the last 7 days to find the actual close
          const startDate = new Date(now);
          startDate.setDate(startDate.getDate() - 7);
          const gainLossData = await broker.getGainLoss({
            start: startDate.toISOString().split('T')[0],
            end: now.toISOString().split('T')[0],
          });
          
          // Look for closed positions matching our option symbols
          const shortOptionSymbol = shortOption.symbol;
          const longOptionSymbol = longOption.symbol;
          
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
          // If we can't get gain/loss data, log but continue
          console.warn('[exit][already-flat][gain-loss-fetch-failed]', JSON.stringify({
            trade_id: trade.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      
      // If we couldn't calculate from gain/loss, estimate based on max profit scenario
      // For credit spreads: max profit means exit_price ≈ 0 (spread expired worthless)
      // For debit spreads: max profit means exit_price ≈ width (spread reached full value)
      // This is a reasonable estimate when we don't have actual Tradier data
      if (actualExitPrice === null && trade.entry_price) {
        const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
        // Since we're already flat and showing max profit PnL, estimate exit_price at max profit
        actualExitPrice = isDebitSpread ? trade.width : 0;
        console.log('[exit][already-flat][estimated-close-price]', JSON.stringify({
          trade_id: trade.id,
          estimated_exit_price: actualExitPrice,
          note: 'Estimated based on max profit scenario - actual close price unknown from Tradier',
        }));
      }
      
      // Use calculated/estimated exit price, or fall back to 0 if we have no entry_price
      const exitPriceToUse = actualExitPrice ?? 0;
      const closedTrade = await markTradeClosed(
        env,
        trade.id,
        exitPriceToUse,
        now,
        'BROKER_ALREADY_FLAT' // Set exit_reason directly
      );
      
      await recordTradeClosed(env, closedTrade);
      
      return {
        trade: closedTrade,
        trigger: decision.trigger,
        success: true,
      };
    }
    
    // STEP 4: Use computed quantities (may be less than target if positions are smaller)
    const shortQtyToClose = quantities.shortQtyToClose;
    const longQtyToClose = quantities.longQtyToClose;
    
    // Determine if this is a debit spread
    const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
    
    // For credit spreads (BULL_PUT_CREDIT, BEAR_CALL_CREDIT):
    //   Entry: sell_to_open short, buy_to_open long
    //   Exit: buy_to_close short, sell_to_close long
    // For debit spreads (BULL_CALL_DEBIT, BEAR_PUT_DEBIT):
    //   Entry: buy_to_open long, sell_to_open short
    //   Exit: sell_to_close long, buy_to_close short
    // So for credit spreads: leg[0] = short (buy_to_close), leg[1] = long (sell_to_close)
    // For debit spreads: leg[0] = long (sell_to_close), leg[1] = short (buy_to_close)
    
    // Determine leg sides and order based on strategy (defined outside try block for fallback access)
    let leg0: SpreadLeg;
    let leg1: SpreadLeg;
    
    if (isDebitSpread) {
      // Debit spread exit: sell_to_close long, buy_to_close short
      leg0 = {
        option_symbol: longOption.symbol,
        side: 'sell_to_close' as const,
        quantity: longQtyToClose,
      };
      leg1 = {
        option_symbol: shortOption.symbol,
        side: 'buy_to_close' as const,
        quantity: shortQtyToClose,
      };
    } else {
      // Credit spread exit: buy_to_close short, sell_to_close long
      leg0 = {
        option_symbol: shortOption.symbol,
        side: 'buy_to_close' as const,
        quantity: shortQtyToClose,
      };
      leg1 = {
        option_symbol: longOption.symbol,
        side: 'sell_to_close' as const,
        quantity: longQtyToClose,
      };
    }
    
    // Place closing order (SANDBOX_PAPER or LIVE)
    let order: BrokerOrder;
    // Import once at the top of the function for reuse
    const { isBenignRejection } = await import('../core/systemMode');
    
    try {
      
      console.log('[exit][initial]', JSON.stringify({
        trade_id: trade.id,
        trade_quantity: trade.quantity,
        target_quantity: targetQuantity,
        short_qty_to_close: shortQtyToClose,
        long_qty_to_close: longQtyToClose,
        short_position: quantities.shortPosition,
        long_position: quantities.longPosition,
        cancelled_orders: cancelledCount,
        option_type: optionType,
        strategy: trade.strategy,
        is_debit_spread: isDebitSpread,
        short_strike: trade.short_strike,
        long_strike: trade.long_strike,
        short_option_symbol: shortOption.symbol,
        long_option_symbol: longOption.symbol,
        short_option_bid: shortOption.bid,
        short_option_ask: shortOption.ask,
        long_option_bid: longOption.bid,
        long_option_ask: longOption.ask,
        exit_order_details: {
          leg0: {
            option_symbol: leg0.option_symbol,
            side: leg0.side,
            quantity: leg0.quantity,
            strike: leg0.option_symbol === shortOption.symbol ? trade.short_strike : trade.long_strike,
          },
          leg1: {
            option_symbol: leg1.option_symbol,
            side: leg1.side,
            quantity: leg1.quantity,
            strike: leg1.option_symbol === shortOption.symbol ? trade.short_strike : trade.long_strike,
          },
          limit_price: closeLimit,
          expected_order_type: isDebitSpread ? 'credit' : 'debit',
        },
        timestamp: now.toISOString(),
      }));
      
      // Log the exact order request before sending
      console.log('[exit][placeOrder][debug]', JSON.stringify({
        trade_id: trade.id,
        strategy: trade.strategy,
        is_debit_spread: isDebitSpread,
        order_type_for_exit: isDebitSpread ? 'credit' : 'debit',
        limit_price: closeLimit,
        legs: [
          {
            option_symbol: leg0.option_symbol,
            side: leg0.side,
            quantity: leg0.quantity,
            strike: leg0.option_symbol === shortOption.symbol ? trade.short_strike : trade.long_strike,
            is_short_leg: leg0.option_symbol === shortOption.symbol,
            is_long_leg: leg0.option_symbol === longOption.symbol,
          },
          {
            option_symbol: leg1.option_symbol,
            side: leg1.side,
            quantity: leg1.quantity,
            strike: leg1.option_symbol === shortOption.symbol ? trade.short_strike : trade.long_strike,
            is_short_leg: leg1.option_symbol === shortOption.symbol,
            is_long_leg: leg1.option_symbol === longOption.symbol,
          },
        ],
        db_trade_details: {
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          quantity: trade.quantity,
          entry_price: trade.entry_price,
        },
        timestamp: now.toISOString(),
      }));
      
      // For multileg orders, Tradier requires type=credit or type=debit (not market)
      // The type is automatically flipped for exits in placeSpreadOrder
      // We still provide limit_price as a safety cap
      order = await broker.placeSpreadOrder({
        symbol: trade.symbol,
        side: 'EXIT',
        legs: [leg0, leg1],
        tag: 'GEKKOWORKS-EXIT',
        strategy: trade.strategy,
        limit_price: closeLimit,  // Required for multileg orders, acts as safety cap
      });
      
      // Immediately check order status to catch any rejections
      try {
        const initialStatus = await broker.getOrder(order.id);
        const orderDetails = await broker.getOrderWithLegs(order.id);
        
        console.log('[exit][order][initial-status]', JSON.stringify({
          trade_id: trade.id,
          order_id: order.id,
          status: initialStatus.status,
          filled_quantity: initialStatus.filled_quantity,
          remaining_quantity: initialStatus.remaining_quantity,
          avg_fill_price: initialStatus.avg_fill_price,
          timestamp: now.toISOString(),
        }));
        
        // If order was immediately rejected, check if it's a quantity mismatch
        if (initialStatus.status === 'REJECTED' || initialStatus.status === 'CANCELLED') {
          const isQuantityMismatch = isQuantityMismatchRejection(orderDetails);
          
          if (isQuantityMismatch) {
            console.log('[exit][order][rejected][quantity-mismatch]', JSON.stringify({
              trade_id: trade.id,
              order_id: order.id,
              status: initialStatus.status,
              reason: 'Quantity mismatch - will retry with fresh position check',
              timestamp: now.toISOString(),
            }));
            
            // Retry once with fresh position check
            return await retryExitWithFreshQuantities(
              env,
              broker,
              trade,
              shortOption.symbol,
              longOption.symbol,
              decision,
              now
            );
          } else {
            console.log('[exit][order][rejected][trying-fallback]', JSON.stringify({
              trade_id: trade.id,
              order_id: order.id,
              status: initialStatus.status,
              reason: 'Multileg order rejected, trying single-leg fallback',
              timestamp: now.toISOString(),
            }));
            
            // Try single-leg fallback orders
            return await trySingleLegFallback(env, broker, trade, leg0, leg1, decision, now);
          }
        }
      } catch (statusError) {
        // Log but don't fail - we'll poll for status in pollForExitFill
        console.log('[exit][order][status-check-error]', JSON.stringify({
          trade_id: trade.id,
          order_id: order.id,
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
      
      // Real error - try single-leg fallback before giving up
      console.log('[exit][order][rejected][trying-fallback]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        error_message: errorMessage,
        reason: 'Multileg order failed, trying single-leg fallback',
        timestamp: now.toISOString(),
      }));
      
      try {
        return await trySingleLegFallback(env, broker, trade, leg0, leg1, decision, now);
      } catch (fallbackError) {
        // Fallback also failed - log and return failure
        console.error('[exit][order][fallback-failed]', JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          strategy: trade.strategy,
          original_error: errorMessage,
          fallback_error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          timestamp: now.toISOString(),
        }));
        
        // Mark as EXIT_ERROR if this is a persistent issue
        // Update trade once with both status and exit_reason
        const errorTrade = await updateTrade(env, trade.id, {
          status: 'EXIT_ERROR',
          exit_reason: 'QUANTITY_MISMATCH',
        });
        
        return {
          trade: errorTrade,
          trigger: decision.trigger,
          success: false,
          reason: `Exit failed: ${errorMessage}. Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        };
      }
    }
    
    // Mark as CLOSING_PENDING
    const updatedTrade = await markTradeClosingPending(
      env,
      trade.id,
      exitReason,
      now,
      order.id
    );
    await notifyExitSubmitted(env, tradingMode, updatedTrade, closeLimit);
    
    // Poll for fill
    const fillResult = await pollForExitFill(broker, updatedTrade, order.id, now);
    
    if (fillResult.filled && fillResult.fillPrice !== undefined) {
      // Mark as closed - exit_reason should already be set from markTradeClosingPending above
      const closedTrade = await markTradeClosed(
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
      // Try one retry
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
  const { getTradesByStatus } = await import('../db/queries');
  const pendingTrades = await getTradesByStatus(env, 'CLOSING_PENDING');
  
  if (pendingTrades.length === 0) {
    return;
  }
  
  const broker = new TradierClient(env);
  
  for (const trade of pendingTrades) {
    if (!trade.broker_order_id_close) {
      // Missing order ID - mark as failed
      await markTradeCancelled(env, trade.id, 'Missing broker order ID for exit');
      continue;
    }
    
    try {
      const order = await broker.getOrder(trade.broker_order_id_close);
      
      if (order.status === 'FILLED') {
        if (order.avg_fill_price === null) {
          // Data error - this is serious, but we'll try to continue
          // The exit engine will handle retry
          continue;
        }
        
        // Mark as closed - exit_reason should already be set from markTradeClosingPending
        const closedTrade = await markTradeClosed(
          env,
          trade.id,
          order.avg_fill_price,
          now,
          trade.exit_reason ?? undefined // Preserve existing exit_reason (convert null to undefined)
        );
        
        // Record in risk system
        await recordTradeClosed(env, closedTrade);
      } else if (order.status === 'CANCELLED' || order.status === 'REJECTED' || order.status === 'EXPIRED') {
        // Order cancelled/rejected - exit engine will handle retry
        // Don't mark trade as cancelled here - let exit engine handle it
        continue;
      } else if (order.status === 'OPEN' || order.status === 'NEW') {
        // Still pending - exit engine will handle retries/timeouts
        // This function is intentionally "hands-off" - only handles FILLED orders
        continue;
      }
    } catch (error) {
      // Broker error - log but continue (might be transient)
      continue;
    }
  }
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
    const targetQuantity = trade.quantity ?? await getDefaultTradeQuantity(env);
    const quantities = await computeAvailableQuantities(
      broker,
      shortOptionSymbol,
      longOptionSymbol,
      targetQuantity
    );
    
      // Check if already flat
      if (quantities.shortQtyToClose === 0 && quantities.longQtyToClose === 0) {
        console.log('[exit][retry-fresh][already-flat]', JSON.stringify({
          trade_id: trade.id,
          timestamp: now.toISOString(),
        }));
        
        // NOTE: exit_price = 0 is a placeholder for broker-flat reconciliation, not a real fill price.
        const closedTrade = await markTradeClosed(env, trade.id, 0, now, 'BROKER_ALREADY_FLAT');
      await recordTradeClosed(env, closedTrade);
      
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
      const closedTrade = await markTradeClosed(env, trade.id, fillResult.fillPrice, new Date(), exitReason);
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
        const closedTrade = await markTradeClosed(
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
      // Emergency exit pricing: accept up to (max_loss + 0.20) to guarantee flattening
      // See comment in executeExitForTrade for full policy documentation
      closeLimit = trade.width - trade.entry_price + 0.20;
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
        // Handle BROKER_ALREADY_FLAT case from resolveExitQuantity
        if (retryQuantity.reason === 'BROKER_ALREADY_FLAT') {
          // NOTE: exit_price = 0 is a placeholder for broker-flat reconciliation, not a real fill price.
          const closedTrade = await markTradeClosed(env, trade.id, 0, now, 'BROKER_ALREADY_FLAT');
        await recordTradeClosed(env, closedTrade);
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
      trade_quantity: trade.quantity,
      default_quantity: trade.quantity ?? (await getDefaultTradeQuantity(env)),
      using_quantity: quantity,
      option_type: optionType,
      strategy: trade.strategy,
      is_debit_spread: isDebitSpread,
      leg0: { option_symbol: leg0.option_symbol, side: leg0.side },
      leg1: { option_symbol: leg1.option_symbol, side: leg1.side },
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
    const fillResult = await pollForExitFill(broker, trade, order.id, now);
    
    if (fillResult.filled && fillResult.fillPrice !== undefined) {
      // Get exit_reason from decision trigger
      const exitReason = mapTriggerToExitReason(decision.trigger);
      const closedTrade = await markTradeClosed(
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
      // Final emergency close
      if (!workingTrade.entry_price) {
        throw new Error('Trade has no entry_price for final emergency close');
      }
      // Emergency exit pricing: accept up to (max_loss + 0.20) to guarantee flattening
      const finalCloseLimit = workingTrade.width - workingTrade.entry_price + 0.20;
      
      const finalQuantity = await resolveExitQuantity(
        env,
        broker,
        workingTrade,
        shortOption.symbol,
        longOption.symbol
      );
      if (!finalQuantity.success) {
        // Handle BROKER_ALREADY_FLAT case
        if (finalQuantity.reason === 'BROKER_ALREADY_FLAT') {
          // NOTE: exit_price = 0 is a placeholder for broker-flat reconciliation, not a real fill price.
          const closedTrade = await markTradeClosed(env, workingTrade.id, 0, now, 'BROKER_ALREADY_FLAT');
          await recordTradeClosed(env, closedTrade);
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
        const closedTrade = await markTradeClosed(
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
        // Mark as CLOSE_FAILED
        await markTradeCancelled(env, trade.id, 'Exit failed after all retries');
        
        return {
          trade,
          trigger: decision.trigger,
          success: false,
          reason: 'Exit failed after all retries',
        };
      }
    }
  } catch (error) {
    return {
      trade,
      trigger: decision.trigger,
      success: false,
      reason: error instanceof Error ? error.message : 'Retry failed',
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
  const defaultQuantity = await getDefaultTradeQuantity(env);
  let exitQuantity = trade.quantity ?? defaultQuantity;
  let updatedTrade = trade;
  
  const positions = await broker.getPositions();
  
  // Log all positions for debugging
  console.log('[exit][resolveQuantity][debug]', JSON.stringify({
    trade_id: trade.id,
    trade_symbol: trade.symbol,
    trade_expiration: trade.expiration,
    trade_short_strike: trade.short_strike,
    trade_long_strike: trade.long_strike,
    trade_quantity: trade.quantity,
    trade_strategy: trade.strategy,
    looking_for_short_symbol: shortOptionSymbol,
    looking_for_long_symbol: longOptionSymbol,
    all_positions: positions.map(p => ({
      symbol: p.symbol,
      quantity: p.quantity,
      cost_basis: p.cost_basis,
    })),
  }));
  
  const shortPosition = positions.find(pos => pos.symbol === shortOptionSymbol);
  const longPosition = positions.find(pos => pos.symbol === longOptionSymbol);
  const shortPosQty = shortPosition ? Math.abs(shortPosition.quantity) : 0;
  const longPosQty = longPosition ? Math.abs(longPosition.quantity) : 0;
  
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
  
  // Align with computeAvailableQuantities: if both legs are zero, treat as BROKER_ALREADY_FLAT
  // This matches the main exit path behavior
  if (availableShortQty === 0 && availableLongQty === 0) {
    console.log('[exit][positions][already_flat]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      short_leg_symbol: shortOptionSymbol,
      long_leg_symbol: longOptionSymbol,
      reason: 'Both legs are zero - position already flat at broker',
    }));
    return { success: false, reason: 'BROKER_ALREADY_FLAT' };
  }
  
  // If only one leg is missing, that's a real error
  if (availableShortQty === 0 || availableLongQty === 0) {
    console.warn('[exit][positions][missing]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      short_leg_symbol: shortOptionSymbol,
      long_leg_symbol: longOptionSymbol,
      available_short_qty: availableShortQty,
      available_long_qty: availableLongQty,
      short_position_found: !!shortPosition,
      long_position_found: !!longPosition,
      short_position_details: shortPosition ? {
        symbol: shortPosition.symbol,
        quantity: shortPosition.quantity,
      } : null,
      long_position_details: longPosition ? {
        symbol: longPosition.symbol,
        quantity: longPosition.quantity,
      } : null,
    }));
    return { success: false, reason: 'Spread legs not found in broker positions' };
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
  
  if (availableQty < exitQuantity) {
    console.warn('[exit][quantity][downsize]', JSON.stringify({
      trade_id: trade.id,
      recorded_quantity: trade.quantity,
      available_short_qty: availableShortQty,
      available_long_qty: availableLongQty,
      adjusted_quantity: availableQty,
    }));
    
    const perContractMaxProfit =
      trade.max_profit != null && trade.quantity
        ? trade.max_profit / trade.quantity
        : null;
    const perContractMaxLoss =
      trade.max_loss != null && trade.quantity
        ? trade.max_loss / trade.quantity
        : null;
    
    updatedTrade = await updateTrade(env, trade.id, {
      quantity: availableQty,
      max_profit:
        perContractMaxProfit !== null
          ? perContractMaxProfit * availableQty
          : trade.max_profit,
      max_loss:
        perContractMaxLoss !== null
          ? perContractMaxLoss * availableQty
          : trade.max_loss,
    });
    exitQuantity = availableQty;
  }
  
  return { success: true, quantity: exitQuantity, trade: updatedTrade };
}

/**
 * Map exit trigger type to exit reason
 */
function mapTriggerToExitReason(trigger: ExitTriggerType): 'PROFIT_TARGET' | 'STOP_LOSS' | 'TIME_EXIT' | 'EMERGENCY' | 'UNKNOWN' {
  switch (trigger) {
    case 'PROFIT_TARGET':
    case 'TRAIL_PROFIT':
      return 'PROFIT_TARGET';
    case 'STOP_LOSS':
      return 'STOP_LOSS';
    case 'TIME_EXIT':
      return 'TIME_EXIT';
    case 'EMERGENCY':
      return 'EMERGENCY';
    case 'IV_CRUSH_EXIT':
    case 'LOW_VALUE_CLOSE':
      return 'UNKNOWN'; // These map to UNKNOWN for now
    default:
      return 'UNKNOWN';
  }
}

