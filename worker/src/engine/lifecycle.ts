/**
 * SAS v1 Trade Lifecycle Management
 * 
 * Orchestrates state transitions for trades.
 * All state changes must go through these helpers.
 * 
 * Per order-lifecycle.md and system-interfaces.md
 */

import type { Env } from '../env';
import type { TradeRow, ExitReason } from '../types';
import { getTrade, updateTrade, cleanupPriceSnaps } from '../db/queries';
import { getTradingMode, getDefaultTradeQuantity } from '../core/config';
import { notifyEntryFilled, notifyExitFilled } from '../notifications/telegram';
import { TradierClient } from '../broker/tradierClient';

/**
 * Mark trade as OPEN after entry fill
 * 
 * Per system-interfaces.md:
 * export async function markTradeOpen(
 *   env: Env,
 *   tradeId: string,
 *   entryPrice: number,
 *   openedAt: Date
 * ): Promise<TradeRow>;
 */
export async function markTradeOpen(
  env: Env,
  tradeId: string,
  entryPrice: number,
  openedAt: Date,
  ivEntry: number | null = null
): Promise<TradeRow> {
  const trade = await getTrade(env, tradeId);
  if (!trade) {
    throw new Error(`Trade ${tradeId} not found`);
  }
  
  // Compute max profit and max loss (per contract, then multiply by quantity)
  // Use configurable default if trade.quantity is not set
  const defaultQuantity = await getDefaultTradeQuantity(env);
  const quantity = trade.quantity ?? defaultQuantity;
  
  // Determine if this is a debit spread
  const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
  
  let max_profit_per_contract: number;
  let max_loss_per_contract: number;
  
  if (isDebitSpread) {
    // For debit spreads:
    // - Max loss = entryPrice (debit paid)
    // - Max profit = width - entryPrice
    max_loss_per_contract = entryPrice;
    max_profit_per_contract = trade.width - entryPrice;
  } else {
    // For credit spreads:
    // - Max profit = entryPrice (credit received)
    // - Max loss = width - entryPrice
    max_profit_per_contract = entryPrice;
    max_loss_per_contract = trade.width - entryPrice;
  }
  
  const max_profit = max_profit_per_contract * quantity;
  const max_loss = max_loss_per_contract * quantity;
  
  const updated = await updateTrade(env, tradeId, {
    status: 'OPEN',
    entry_price: entryPrice, // Store per-contract price
    opened_at: openedAt.toISOString(),
    max_profit,
    max_loss,
    iv_entry: ivEntry,
  });

  console.log(
    '[trade] lifecycle',
    JSON.stringify({
      trade_id: tradeId,
      from_status: trade.status,
      to_status: 'OPEN',
      transition: 'ENTRY_FILLED',
      entry_price: entryPrice,
      opened_at: openedAt.toISOString(),
      max_profit,
      max_loss,
      iv_entry: ivEntry,
    }),
  );

  const tradingMode = await getTradingMode(env);
  await notifyEntryFilled(env, tradingMode, updated);

  // Validate spread invariants immediately after opening
  // This is a last-line-of-defense sanity check
  try {
    const validationResult = await validateSpreadInvariants(env, tradeId);
    if (!validationResult.valid) {
      // Any valid === false indicates a structural issue (strike mismatch, missing legs, etc.)
      // Broker errors return valid === true with VALIDATION_SKIPPED_BROKER_ERROR (handled inside validateSpreadInvariants)
      console.error('[CRITICAL] spread_invariants_failed', JSON.stringify({
        trade_id: tradeId,
        reason: validationResult.reason,
        details: validationResult.details,
      }));
      
      await updateTrade(env, tradeId, {
        status: 'INVALID_STRUCTURE',
      });
      
      // Return the updated trade with invalid status
      return await getTrade(env, tradeId) || updated;
    }
    // If valid === true, validation passed or was skipped due to broker error (will retry in next cycle)
  } catch (error) {
    // If validation throws an unexpected error, log but don't mark as invalid
    // (will be checked in next monitor cycle)
    console.error('[lifecycle] invariant_validation_error', JSON.stringify({
      trade_id: tradeId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  return updated;
}

/**
 * Validate spread invariants after trade open
 * 
 * Ensures:
 * - Strategy-consistent strike relationship (based on width + strategy)
 * - Width == 5 (current v1 constraint - see note below)
 * - Both legs exist in the option chain for the symbol/expiration
 * - Both legs exist in positions (after sync window)
 * - Short leg has negative quantity, long leg positive
 * - |qty_short| == |qty_long|
 * - Exactly 2 legs in positions (1 short, 1 long)
 * 
 * NOTE: Width validation is hard-coded to 5. If v1 ever supports variable widths,
 * this check must be updated before changing strategy builders.
 * 
 * This is a last-line-of-defense sanity check.
 */
async function validateSpreadInvariants(
  env: Env,
  tradeId: string
): Promise<{ valid: boolean; reason?: string; details?: any }> {
  const trade = await getTrade(env, tradeId);
  if (!trade) {
    return { valid: false, reason: 'TRADE_NOT_FOUND' };
  }
  
  // Only validate trades that are actually OPEN
  // Skip validation for trades that are still pending entry or have been closed
  if (trade.status !== 'OPEN') {
    return { valid: true, reason: 'SKIPPED_NOT_OPEN' };
  }
  
  // Defensive check: strategy must be set for validation
  if (!trade.strategy) {
    console.error('[lifecycle] validation_failed_missing_strategy', JSON.stringify({
      trade_id: tradeId,
      note: 'Trade missing strategy field - cannot validate spread invariants',
    }));
    return {
      valid: false,
      reason: 'MISSING_STRATEGY',
      details: {
        note: 'Trade must have strategy field set to validate spread structure',
      },
    };
  }
  
  // Determine option type and strike relationship based on strategy
  // Each strategy has a specific strike pattern:
  // - BULL_PUT_CREDIT: puts, long_strike = short_strike - width (short higher, long lower)
  // - BEAR_PUT_DEBIT: puts, long_strike = short_strike + width (long higher, short lower)
  // - BEAR_CALL_CREDIT: calls, long_strike = short_strike + width (short lower, long higher)
  // - BULL_CALL_DEBIT: calls, long_strike = short_strike - width (long lower, short higher)
  const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
  
  let expectedLongStrike: number;
  if (trade.strategy === 'BULL_PUT_CREDIT') {
    // Put credit: short higher, long lower
    expectedLongStrike = trade.short_strike - trade.width;
  } else if (trade.strategy === 'BEAR_PUT_DEBIT') {
    // Put debit: long higher, short lower
    expectedLongStrike = trade.short_strike + trade.width;
  } else if (trade.strategy === 'BEAR_CALL_CREDIT') {
    // Call credit: short lower, long higher
    expectedLongStrike = trade.short_strike + trade.width;
  } else if (trade.strategy === 'BULL_CALL_DEBIT') {
    // Call debit: long lower, short higher
    expectedLongStrike = trade.short_strike - trade.width;
  } else {
    // Fallback for unknown strategies (shouldn't happen)
    console.warn('[lifecycle] unknown_strategy_for_validation', JSON.stringify({
      trade_id: tradeId,
      strategy: trade.strategy,
    }));
    expectedLongStrike = trade.short_strike - trade.width; // Default to credit spread pattern
  }
  
  if (Math.abs(trade.long_strike - expectedLongStrike) > 0.01) {
    console.error('[lifecycle][validation][strike_mismatch]', JSON.stringify({
      trade_id: tradeId,
      strategy: trade.strategy,
      option_type: optionType,
      short_strike: trade.short_strike,
      long_strike: trade.long_strike,
      expected_long_strike: expectedLongStrike,
      width: trade.width,
      difference: Math.abs(trade.long_strike - expectedLongStrike),
    }));
    return {
      valid: false,
      reason: 'STRIKE_MISMATCH',
      details: {
        short_strike: trade.short_strike,
        long_strike: trade.long_strike,
        expected_long_strike: expectedLongStrike,
        width: trade.width,
        strategy: trade.strategy,
        option_type: optionType,
        difference: Math.abs(trade.long_strike - expectedLongStrike),
      },
    };
  }
  
  // Check that width is exactly 5
  // NOTE: v1 only supports width=5 spreads; update this check before changing strategy builders
  if (trade.width !== 5) {
    return {
      valid: false,
      reason: 'INVALID_WIDTH',
      details: {
        width: trade.width,
        expected: 5,
      },
    };
  }
  
  // Verify both legs exist in broker positions
  const broker = new TradierClient(env);
  try {
    const positions = await broker.getPositions();
    
    // optionType already determined above - reuse it
    
    // Get option chain to find option symbols
    const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
    const shortOption = optionChain.find(
      opt => opt.strike === trade.short_strike && opt.type === optionType
    );
    const longOption = optionChain.find(
      opt => opt.strike === trade.long_strike && opt.type === optionType
    );
    
    if (!shortOption || !longOption) {
      return {
        valid: false,
        reason: 'LEGS_MISSING_IN_CHAIN',
        details: {
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          expiration: trade.expiration,
          strategy: trade.strategy,
          option_type: optionType,
        },
      };
    }
    
    // Find positions matching our legs
    const shortPosition = positions.find(pos => pos.symbol === shortOption.symbol);
    const longPosition = positions.find(pos => pos.symbol === longOption.symbol);
    
    // Check if trade was recently opened (within last 2 minutes)
    // Positions might not be synced yet, so we'll be lenient
    const openedAt = trade.opened_at ? new Date(trade.opened_at) : null;
    const recentlyOpened = openedAt && (Date.now() - openedAt.getTime()) < 2 * 60 * 1000; // 2 minutes
    
    if (!shortPosition) {
      // If recently opened, log warning but don't fail validation
      if (recentlyOpened) {
        console.warn('[lifecycle] short_position_not_found_yet', JSON.stringify({
          trade_id: tradeId,
          short_option_symbol: shortOption.symbol,
          short_strike: trade.short_strike,
          strategy: trade.strategy,
          option_type: optionType,
          opened_at: trade.opened_at,
          note: 'Trade recently opened, position may not be synced yet',
        }));
        return { valid: true, reason: 'PENDING_POSITION_SYNC' };
      }
      
      return {
        valid: false,
        reason: 'SHORT_LEG_MISSING_IN_POSITIONS',
        details: {
          short_option_symbol: shortOption.symbol,
          short_strike: trade.short_strike,
          strategy: trade.strategy,
          option_type: optionType,
          opened_at: trade.opened_at,
        },
      };
    }
    
    if (!longPosition) {
      // If recently opened, log warning but don't fail validation
      if (recentlyOpened) {
        console.warn('[lifecycle] long_position_not_found_yet', JSON.stringify({
          trade_id: tradeId,
          long_option_symbol: longOption.symbol,
          long_strike: trade.long_strike,
          strategy: trade.strategy,
          option_type: optionType,
          opened_at: trade.opened_at,
          note: 'Trade recently opened, position may not be synced yet',
        }));
        return { valid: true, reason: 'PENDING_POSITION_SYNC' };
      }
      
      return {
        valid: false,
        reason: 'LONG_LEG_MISSING_IN_POSITIONS',
        details: {
          long_option_symbol: longOption.symbol,
          long_strike: trade.long_strike,
          strategy: trade.strategy,
          option_type: optionType,
          opened_at: trade.opened_at,
        },
      };
    }
    
    // Check quantities match
    // For all spreads:
    // - Short leg should have negative quantity (sold)
    // - Long leg should have positive quantity (bought)
    // - Absolute values should match
    
    // First check: verify direction signs are correct
    if (shortPosition.quantity >= 0) {
      return {
        valid: false,
        reason: 'LEG_DIRECTION_MISMATCH',
        details: {
          short_quantity: shortPosition.quantity,
          expected: 'negative (sold)',
          note: 'Short leg should have negative quantity',
        },
      };
    }
    
    if (longPosition.quantity <= 0) {
      return {
        valid: false,
        reason: 'LEG_DIRECTION_MISMATCH',
        details: {
          long_quantity: longPosition.quantity,
          expected: 'positive (bought)',
          note: 'Long leg should have positive quantity',
        },
      };
    }
    
    // Now check absolute values match
    const shortQty = Math.abs(shortPosition.quantity);
    const longQty = Math.abs(longPosition.quantity);
    
    // Get expected quantity from trade record (with fallback to default)
    // Use top-level import instead of dynamic import
    const defaultQuantity = await getDefaultTradeQuantity(env);
    const expectedQuantity = trade.quantity ?? defaultQuantity;
    
    // First check: short and long quantities must match in absolute value
    if (shortQty !== longQty) {
      return {
        valid: false,
        reason: 'QUANTITY_MISMATCH',
        details: {
          short_quantity: shortPosition.quantity,
          long_quantity: longPosition.quantity,
          short_abs: shortQty,
          long_abs: longQty,
        },
      };
    }
    
    // Second check: quantity must be at least the trade record quantity
    // Note: Tradier quantity may be higher if multiple trades share the same positions
    // We only fail if Tradier has LESS than expected (data integrity issue)
    console.log('[lifecycle] quantity_check', JSON.stringify({
      trade_id: tradeId,
      shortQty,
      expectedQuantity,
      comparison: shortQty < expectedQuantity ? 'FAIL' : shortQty > expectedQuantity ? 'WARN' : 'PASS',
    }));
    
    if (shortQty < expectedQuantity) {
      return {
        valid: false,
        reason: 'QUANTITY_MISMATCH_WITH_TRADE',
        details: {
          short_quantity: shortPosition.quantity,
          long_quantity: longPosition.quantity,
          trade_quantity: expectedQuantity,
          tradier_quantity: shortQty,
          note: 'Tradier quantity is less than trade quantity - possible data integrity issue',
        },
      };
    }
    
    // If Tradier quantity is greater, it's likely multiple trades sharing positions
    // Log a warning but don't fail validation
    if (shortQty > expectedQuantity) {
      console.warn('[lifecycle] tradier_quantity_greater_than_trade', JSON.stringify({
        trade_id: tradeId,
        trade_quantity: expectedQuantity,
        tradier_quantity: shortQty,
        note: 'Multiple trades may share these positions',
      }));
    }
    
    // Check that we have exactly 2 legs (short + long)
    const legCount = (shortPosition ? 1 : 0) + (longPosition ? 1 : 0);
    if (legCount !== 2) {
      return {
        valid: false,
        reason: 'INVALID_LEG_COUNT',
        details: {
          leg_count: legCount,
          expected: 2,
        },
      };
    }
    
    // All invariants passed
    console.log('[lifecycle][validation][passed]', JSON.stringify({
      trade_id: tradeId,
      strategy: trade.strategy,
      short_strike: trade.short_strike,
      long_strike: trade.long_strike,
      width: trade.width,
      quantity: trade.quantity,
      short_position_qty: shortQty,
      long_position_qty: longQty,
    }));
    return { valid: true };
  } catch (error) {
    // If we can't validate due to broker error, skip validation rather than invalidate
    // This allows transient broker errors to be retried without killing good trades
    // The validation will be retried in the next monitor cycle
    console.warn('[lifecycle] validation_skipped_broker_error', JSON.stringify({
      trade_id: tradeId,
      error: error instanceof Error ? error.message : String(error),
      note: 'Broker error during validation - skipping validation, will retry in next cycle',
    }));
    return {
      valid: true,
      reason: 'VALIDATION_SKIPPED_BROKER_ERROR',
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Mark trade as CLOSING_PENDING after exit trigger
 * 
 * Per system-interfaces.md:
 * export async function markTradeClosingPending(
 *   env: Env,
 *   tradeId: string,
 *   reason: ExitReason,
 *   submittedAt: Date,
 *   brokerOrderId: string
 * ): Promise<TradeRow>;
 */
export async function markTradeClosingPending(
  env: Env,
  tradeId: string,
  reason: ExitReason,
  submittedAt: Date,
  brokerOrderId: string
): Promise<TradeRow> {
  const trade = await getTrade(env, tradeId);
  if (!trade) {
    throw new Error(`Trade ${tradeId} not found`);
  }
  
  const updated = await updateTrade(env, tradeId, {
    status: 'CLOSING_PENDING',
    exit_reason: reason,
    broker_order_id_close: brokerOrderId,
  });
  
  console.log(
    '[trade] lifecycle',
    JSON.stringify({
      trade_id: tradeId,
      from_status: trade.status,
      to_status: 'CLOSING_PENDING',
      transition: 'EXIT_SUBMITTED',
      exit_reason: reason,
      broker_order_id_close: brokerOrderId,
      submitted_at: submittedAt.toISOString(),
    }),
  );
  
  return updated;
}

/**
 * Mark trade as CLOSED after exit fill
 * 
 * Per system-interfaces.md:
 * export async function markTradeClosed(
 *   env: Env,
 *   tradeId: string,
 *   exitPrice: number,
 *   closedAt: Date,
 *   exitReason?: ExitReason
 * ): Promise<TradeRow>;
 */
export async function markTradeClosed(
  env: Env,
  tradeId: string,
  exitPrice: number,
  closedAt: Date,
  exitReason?: ExitReason
): Promise<TradeRow> {
  const trade = await getTrade(env, tradeId);
  if (!trade) {
    throw new Error(`Trade ${tradeId} not found`);
  }
  
  if (!trade.entry_price) {
    throw new Error(`Trade ${tradeId} has no entry_price`);
  }
  
  // Compute realized PnL (per trade, matching max_profit/max_loss units)
  // Get quantity to multiply per-contract PnL
  const defaultQuantity = await getDefaultTradeQuantity(env);
  const quantity = trade.quantity ?? defaultQuantity;
  
  // Determine if this is a debit spread
  const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
  
  // Calculate per-contract PnL
  let perContractPnL: number;
  if (isDebitSpread) {
    // For debit spreads: entry_price is debit paid, exit_price is credit received
    // PnL = exitPrice - entry_price (positive if we received more than we paid)
    perContractPnL = exitPrice - trade.entry_price;
  } else {
    // For credit spreads: entry_price is credit received, exit_price is debit paid
    // PnL = entry_price - exitPrice (positive if we received more than we paid to close)
    perContractPnL = trade.entry_price - exitPrice;
  }
  
  // Multiply by quantity to get total realized PnL for the trade
  const realized_pnl = perContractPnL * quantity;
  
  // Use provided exit_reason, or preserve existing one, or default to UNKNOWN
  const exitReasonToSet = exitReason ?? trade.exit_reason ?? 'UNKNOWN';
  
  const updated = await updateTrade(env, tradeId, {
    status: 'CLOSED',
    exit_price: exitPrice,
    closed_at: closedAt.toISOString(),
    realized_pnl,
    exit_reason: exitReasonToSet,
  });

  console.log(
    '[trade] lifecycle',
    JSON.stringify({
      trade_id: tradeId,
      from_status: trade.status,
      to_status: 'CLOSED',
      transition: 'EXIT_FILLED',
      exit_price: exitPrice,
      closed_at: closedAt.toISOString(),
      realized_pnl,
      exit_reason: updated.exit_reason,
    }),
  );

  const tradingMode = await getTradingMode(env);
  await notifyExitFilled(env, tradingMode, updated);

  // Clean up price snap entries for this trade (they're no longer needed)
  try {
    const deleted = await cleanupPriceSnaps(env, tradeId);
    if (deleted > 0) {
      console.log('[lifecycle] cleaned_up_price_snaps', JSON.stringify({
        trade_id: tradeId,
        deleted_count: deleted,
      }));
    }
  } catch (error) {
    // Non-fatal - log but don't fail the close operation
    console.warn('[lifecycle] price_snap_cleanup_failed', JSON.stringify({
      trade_id: tradeId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  return updated;
}

/**
 * Mark trade as CANCELLED
 * 
 * Per system-interfaces.md:
 * export async function markTradeCancelled(
 *   env: Env,
 *   tradeId: string,
 *   reason: string
 * ): Promise<TradeRow>;
 */
export async function markTradeCancelled(
  env: Env,
  tradeId: string,
  reason: string
): Promise<TradeRow> {
  const trade = await getTrade(env, tradeId);
  if (!trade) {
    throw new Error(`Trade ${tradeId} not found`);
  }
  
  // Store cancellation reason - use UNKNOWN as exit_reason enum, but log the actual reason
  // Note: exit_reason is typed as ExitReason enum, but cancellation reasons are free-text
  // We log the actual reason for debugging while using UNKNOWN for the enum field
  console.log('[lifecycle] cancellation_reason', JSON.stringify({
    trade_id: tradeId,
    cancellation_reason: reason,
    note: 'Cancellation reason logged separately from exit_reason enum',
  }));
  
  const updated = await updateTrade(env, tradeId, {
    status: 'CANCELLED',
    exit_reason: 'UNKNOWN', // ExitReason enum - actual reason logged above
  });
  
  console.log(
    '[trade] lifecycle',
    JSON.stringify({
      trade_id: tradeId,
      from_status: trade.status,
      to_status: 'CANCELLED',
      transition: 'CANCELLED',
      cancellation_reason: reason,
      exit_reason: updated.exit_reason,
    }),
  );
  
  return updated;
}

