/**
 * SAS v1 Monitoring Engine
 * 
 * Implements monitoring.md exactly.
 * 
 * Responsibilities:
 * - Fetch live quotes for open trades
 * - Compute PnL and metrics
 * - Detect instability
 * - Determine exit triggers in priority order
 */

import type { Env } from '../env';
import type {
  TradeRow,
  MonitoringDecision,
  MonitoringMetrics,
  ExitTriggerType,
  OptionQuote,
  UnderlyingQuote,
} from '../types';
import { TradierClient } from '../broker/tradierClient';
import { computeDTE } from '../core/time';
import { getSetting, setSetting, updateTrade, getOpenTrades } from '../db/queries';
import { getExitRuleThresholds, getDefaultTradeQuantity } from '../core/config';
import { toET } from '../core/time';

/**
 * Evaluate an open trade and determine exit action
 * 
 * Per system-interfaces.md:
 * export async function evaluateOpenTrade(
 *   env: Env,
 *   trade: TradeRow,
 *   now: Date
 * ): Promise<MonitoringDecision>;
 */
export async function evaluateOpenTrade(
  env: Env,
  trade: TradeRow,
  now: Date
): Promise<MonitoringDecision> {
  // All trades are managed by Gekkoworks - no external trade filtering
  // We check structural integrity and time-based exits even without entry_price
  
  const broker = new TradierClient(env);
  
  try {
    // Note: We catch errors at the end to handle transient broker errors gracefully
    // Only structural/data corruption issues should trigger EMERGENCY exits
    // [data][tradier][quotes] Fetch live underlying quote
    const quoteStartTime = Date.now();
    const underlying = await broker.getUnderlyingQuote(trade.symbol);
    const quoteDurationMs = Date.now() - quoteStartTime;
    
    console.log('[data][tradier][quotes]', JSON.stringify({
      symbol: trade.symbol,
      last: underlying.last,
      duration_ms: quoteDurationMs,
      timestamp: now.toISOString(),
    }));
    
    // [data][tradier][chains] Fetch live option chain
    const chainStartTime = Date.now();
    const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
    const chainDurationMs = Date.now() - chainStartTime;
    
    console.log('[data][tradier][chains]', JSON.stringify({
      symbol: trade.symbol,
      expiration: trade.expiration,
      count: optionChain.length,
      duration_ms: chainDurationMs,
      timestamp: now.toISOString(),
    }));
    
    // [STRUCTURAL_INTEGRITY] Check spread structure FIRST (works without entry_price)
    const integrityCheck = await checkStructuralIntegrity(env, trade, broker, optionChain);
    if (!integrityCheck.valid) {
      // Compute DTE for the error response
      const dte = computeDTE(trade.expiration, now);
      
      console.log('[monitor][structural_break]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        expiration: trade.expiration,
        reason: integrityCheck.reason,
        details: integrityCheck.details,
        timestamp: now.toISOString(),
      }));
      // Return emergency trigger to close immediately
      console.log('[monitor][exit][triggered]', JSON.stringify({
        trade_id: trade.id,
        exit_reason: 'STRUCTURAL_BREAK',
        reason: integrityCheck.reason,
        details: integrityCheck.details,
        timestamp: now.toISOString(),
      }));
      return {
        trigger: 'EMERGENCY' as ExitTriggerType, // Structural break is an emergency
        metrics: {
          current_mark: 0,
          unrealized_pnl: 0,
          pnl_fraction: 0,
          loss_fraction: 0,
          dte,
          underlying_price: underlying.last,
          underlying_change_1m: 0,
          underlying_change_15s: 0,
          liquidity_ok: false,
          quote_integrity_ok: false,
        },
      };
    }
    
    // For P&L-based exits, we need entry_price
    // However, we still check time-based exits even without entry_price
    // (structural integrity was already checked above)
    const hasEntryPrice = trade.entry_price && trade.entry_price > 0;
    
    if (!hasEntryPrice) {
      console.log('[data][missing-entry-price]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        expiration: trade.expiration,
        reason: 'entry_price missing or invalid, cannot compute P&L-based exits, but will check time-based exits',
        timestamp: now.toISOString(),
      }));
      
      // Compute DTE for time-based exit check
      const dteForTimeExit = computeDTE(trade.expiration, now);
      
      // Create minimal metrics for time-based exit evaluation
      const minimalMetrics: MonitoringMetrics = {
        current_mark: 0,
        unrealized_pnl: 0,
        pnl_fraction: 0,
        loss_fraction: 0,
        dte: dteForTimeExit,
        underlying_price: underlying.last,
        underlying_change_1m: 0,
        underlying_change_15s: 0,
        liquidity_ok: false,
        quote_integrity_ok: false,
      };
      
      // Check time-based exits even without entry_price
      // Pass minimal metrics - evaluateCloseRules will skip P&L-based rules but check TIME_EXIT
      // Pass optionChain to avoid refetching if needed
      const timeBasedDecision = await evaluateCloseRules(env, trade, minimalMetrics, now, optionChain);
      
      // If time-based exit triggered, return it; otherwise return NONE
      if (timeBasedDecision.trigger !== 'NONE') {
        return timeBasedDecision;
      }
      
      return {
        trigger: 'NONE',
        metrics: minimalMetrics,
      };
    }
    
    // Determine option type based on strategy
    const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
    const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
    
    // Find option quotes for our legs
    const shortOption = optionChain.find(
      opt => opt.strike === trade.short_strike && opt.type === optionType
    );
    const longOption = optionChain.find(
      opt => opt.strike === trade.long_strike && opt.type === optionType
    );
    
    // Check data integrity - Emergency if missing
    if (!shortOption || !longOption) {
      console.error('[data][missing-field]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        option_type: optionType,
        missing_legs: {
          short: !shortOption,
          long: !longOption,
        },
      }));
      return {
        trigger: 'EMERGENCY',
        metrics: createEmergencyMetrics(trade, now),
      };
    }
    
    if (!shortOption.bid || !shortOption.ask || !longOption.bid || !longOption.ask) {
      console.error('[data][missing-field]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        option_type: optionType,
        missing_quotes: {
          short_bid: !shortOption.bid,
          short_ask: !shortOption.ask,
          long_bid: !longOption.bid,
          long_ask: !longOption.ask,
        },
      }));
      return {
        trigger: 'EMERGENCY',
        metrics: createEmergencyMetrics(trade, now),
      };
    }
    
    // Compute metrics (uses fresh quotes from Tradier - no stale data)
    const metrics = await computeMonitoringMetrics(
      env,
      trade,
      underlying,
      shortOption,
      longOption,
      now
    );
    
    // Log data freshness confirmation
    console.log('[data][freshness]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      strategy: trade.strategy,
      quote_age_ms: 0, // Quotes just fetched - always fresh
      underlying_price: underlying.last,
      short_bid: shortOption.bid,
      short_ask: shortOption.ask,
      long_bid: longOption.bid,
      long_ask: longOption.ask,
      timestamp: now.toISOString(),
    }));
    
    // Check quote integrity
    if (!metrics.quote_integrity_ok || !metrics.liquidity_ok) {
      return {
        trigger: 'EMERGENCY',
        metrics,
      };
    }
    
    // Note: max_seen_profit_fraction is updated in evaluateCloseRules to avoid double-updating
    // Log exit evaluation with full context
    // Get current IV for logging
    let iv_now: number | null = null;
    try {
      const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
      // Determine option type based on strategy
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      const shortOption = optionChain.find(
        opt => opt.strike === trade.short_strike && opt.type === optionType
      );
      if (shortOption && shortOption.implied_volatility) {
        iv_now = shortOption.implied_volatility;
      }
    } catch (error) {
      // IV fetch failed - log without it
    }
    
    console.log('[monitor][exit][evaluate]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      expiration: trade.expiration,
      short_strike: trade.short_strike,
      long_strike: trade.long_strike,
      pnl_abs: metrics.unrealized_pnl,
      pnl_pct: metrics.pnl_fraction,
      dte: metrics.dte,
      iv_entry: trade.iv_entry,
      iv_now: iv_now,
      current_mark: metrics.current_mark,
      underlying_price: metrics.underlying_price,
      timestamp: now.toISOString(),
    }));

    // Evaluate exit triggers in priority order (first match wins)
    // Pass env so we can read config-driven thresholds
    // Pass optionChain to avoid refetching for IV crush check
    const decision = await evaluateCloseRules(env, trade, metrics, now, optionChain);

    // Single clear log line showing all metrics and decision (per spec)
    const profit_fraction = metrics.pnl_fraction; // pnl_fraction = profit_fraction for credit spreads
    console.log('[closeEval]', JSON.stringify({
      trade_id: trade.id,
      symbol: trade.symbol,
      price: metrics.current_mark,
      uPnL: metrics.unrealized_pnl,
      pf: profit_fraction,
      lf: metrics.loss_fraction,
      dte: metrics.dte,
      decision: decision.trigger,
      timestamp: now.toISOString(),
    }));

    return decision;
  } catch (error) {
    // Handle errors based on type - only structural/data corruption should trigger EMERGENCY
    // Transient broker errors should be logged but not trigger exits
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isStructuralError = 
      errorMessage.includes('missing') ||
      errorMessage.includes('invalid') ||
      errorMessage.includes('mismatch') ||
      errorMessage.includes('STRIKE_MISMATCH') ||
      errorMessage.includes('LEG_MISSING');
    
    if (isStructuralError) {
      // Structural/data integrity issue - trigger emergency
      console.error('[monitor][error][structural]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: now.toISOString(),
      }));
      return {
        trigger: 'EMERGENCY',
        metrics: createEmergencyMetrics(trade, now),
      };
    } else {
      // Transient error (timeout, network, etc.) - log but don't trigger exit
      // Will be retried on next monitoring cycle
      console.warn('[monitor][error][transient]', JSON.stringify({
        trade_id: trade.id,
        symbol: trade.symbol,
        error: errorMessage,
        note: 'Transient error - will retry on next cycle',
        timestamp: now.toISOString(),
      }));
      // Return NONE to avoid triggering exits on transient errors
      const dte = computeDTE(trade.expiration, now);
      return {
        trigger: 'NONE',
        metrics: {
          current_mark: 0,
          unrealized_pnl: 0,
          pnl_fraction: 0,
          loss_fraction: 0,
          dte,
          underlying_price: 0,
          underlying_change_1m: 0,
          underlying_change_15s: 0,
          liquidity_ok: false,
          quote_integrity_ok: false,
        },
      };
    }
  }
}

/**
 * Compute monitoring metrics
 */
async function computeMonitoringMetrics(
  env: Env,
  trade: TradeRow,
  underlying: UnderlyingQuote,
  shortOption: OptionQuote,
  longOption: OptionQuote,
  now: Date
): Promise<MonitoringMetrics> {
  if (!trade.entry_price) {
    throw new Error('Trade has no entry_price');
  }
  
  // Mark price calculation depends on strategy type
  const markShort = (shortOption.bid + shortOption.ask) / 2;
  const markLong = (longOption.bid + longOption.ask) / 2;
  
  // For credit spreads: mark = short_mid - long_mid (what we'd pay to close)
  // For debit spreads: mark = long_mid - short_mid (what we'd receive to close)
  const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
  const currentMark = isDebitSpread ? markLong - markShort : markShort - markLong;
  
  // PnL calculation
  let unrealized_pnl: number;
  let max_profit: number;
  let max_loss: number;
  
  if (isDebitSpread) {
    // Debit spread: entry_price = debit paid, max_loss = debit, max_profit = width - debit
    unrealized_pnl = currentMark - trade.entry_price; // Positive when profitable
    max_profit = trade.width - trade.entry_price;
    max_loss = trade.entry_price;
  } else {
    // Credit spread: entry_price = credit received, max_profit = credit, max_loss = width - credit
    unrealized_pnl = trade.entry_price - currentMark; // Positive when profitable
    max_profit = trade.entry_price;
    max_loss = trade.width - trade.entry_price;
  }
  
  // Clean metric definitions:
  // profit_fraction = unrealized_pnl / max_profit (can be > 1 if we exceed max profit)
  // loss_fraction = (-unrealized_pnl) / max_loss, clamped at >= 0
  const profit_fraction = max_profit > 0 ? unrealized_pnl / max_profit : 0;
  const loss_fraction = max_loss > 0 ? Math.max(0, (-unrealized_pnl) / max_loss) : 0;
  
  // Keep pnl_fraction for backward compatibility in logs (same as profit_fraction)
  const pnl_fraction = profit_fraction;
  
  // DTE
  const dte = computeDTE(trade.expiration, now);
  
  // Underlying price and changes
  const underlying_price = underlying.last;
  const { change_1m, change_15s } = await computeUnderlyingChanges(
    env,
    trade.id,
    underlying_price,
    now
  );
  
  // Liquidity check (threshold configurable via CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD)
  const liquiditySpreadThreshold = parseFloat(
    (await getSetting(env, 'CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD')) || '0.30'
  );
  const shortSpread = shortOption.ask - shortOption.bid;
  const longSpread = longOption.ask - longOption.bid;
  const liquidity_ok = shortSpread <= liquiditySpreadThreshold && longSpread <= liquiditySpreadThreshold;
  
  // Quote integrity
  const quote_integrity_ok =
    shortOption.bid > 0 &&
    shortOption.ask > 0 &&
    longOption.bid > 0 &&
    longOption.ask > 0 &&
    shortOption.bid < shortOption.ask &&
    longOption.bid < longOption.ask;
  
  return {
    current_mark: currentMark,
    unrealized_pnl,
    pnl_fraction,
    loss_fraction,
    dte,
    underlying_price,
    underlying_change_1m: change_1m,
    underlying_change_15s: change_15s,
    liquidity_ok,
    quote_integrity_ok,
  };
}

/**
 * Close rules evaluator – ordered, deterministic
 * 
 * All thresholds are config-driven via settings table (CLOSE_RULE_* keys).
 * Falls back to defaults if not set.
 */
async function evaluateCloseRules(
  env: Env,
  trade: TradeRow,
  metrics: MonitoringMetrics,
  now: Date,
  optionChain?: OptionQuote[]
): Promise<MonitoringDecision> {
  // Load exit rule thresholds from config
  const exitRules = await getExitRuleThresholds(env);
  
  // Emergency thresholds (also configurable)
  const LIQUIDITY_SPREAD_THRESHOLD = parseFloat(
    (await getSetting(env, 'CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD')) || '0.30'
  );
  const UNDERLYING_SPIKE_THRESHOLD = parseFloat(
    (await getSetting(env, 'CLOSE_RULE_UNDERLYING_SPIKE_THRESHOLD')) || '0.005'
  );

  const dte = metrics.dte;
  // For credit spreads: pnl_fraction = profit_fraction (unrealized_pnl / max_profit)
  const profit_fraction = metrics.pnl_fraction;

  // 0) Emergency conditions (quote/liquidity/volatility shock)
  // Note: Structural break is checked in evaluateOpenTrade before this function
  if (await shouldTriggerEmergency(env, metrics, LIQUIDITY_SPREAD_THRESHOLD, UNDERLYING_SPIKE_THRESHOLD)) {
    console.log('[monitor][exit][triggered]', JSON.stringify({
      trade_id: trade.id,
      exit_reason: 'EMERGENCY',
      profit_fraction,
      dte,
      timestamp: now.toISOString(),
    }));
    return { trigger: 'EMERGENCY', metrics };
  }

  // 1) Update max_seen_profit_fraction (trailing profit tracking)
  const currentProfitFraction = Math.max(0, profit_fraction); // Only track positive PnL
  const currentPeak = trade.max_seen_profit_fraction ?? 0;
  const newPeak = Math.max(currentPeak, currentProfitFraction);
  
  // Update trade's max_seen_profit_fraction if it increased
  if (newPeak > currentPeak) {
    const { updateTrade } = await import('../db/queries');
    await updateTrade(env, trade.id, { max_seen_profit_fraction: newPeak });
    console.log('[monitor][exit][trail][armed]', JSON.stringify({
      trade_id: trade.id,
      peak: newPeak,
      current: currentProfitFraction,
      timestamp: now.toISOString(),
    }));
  }
  
  // 2) TRAILING_PROFIT_EXIT (trail once armed, close on giveback)
  const peak = newPeak;
  const armed = peak >= exitRules.trailArmProfitFraction;
  const giveback = armed && (peak - currentProfitFraction) >= exitRules.trailGivebackFraction;
  
  if (giveback) {
    console.log('[monitor][exit][trail][triggered]', JSON.stringify({
      trade_id: trade.id,
      peak,
      current: currentProfitFraction,
      giveback: peak - currentProfitFraction,
      threshold: exitRules.trailGivebackFraction,
      timestamp: now.toISOString(),
    }));
    return { trigger: 'TRAIL_PROFIT' as ExitTriggerType, metrics };
  }

  // 3) PROFIT_TARGET - close when profit_fraction >= threshold
  // Debit spreads: 0.60 (60%), Credit spreads: 0.50 (50%)
  const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
  const defaultProfitTarget = isDebitSpread ? '0.60' : '0.50';
  const profitTargetFraction = parseFloat(
    (await getSetting(env, 'CLOSE_RULE_PROFIT_TARGET_FRACTION')) || defaultProfitTarget
  );
  
  if (profit_fraction >= profitTargetFraction) {
    console.log('[closeRules] profit check', JSON.stringify({
      trade_id: trade.id,
      profit_fraction,
      threshold: profitTargetFraction,
      decision: 'TRIGGER',
      timestamp: now.toISOString(),
    }));
    console.log('[monitor][exit][triggered]', JSON.stringify({
      trade_id: trade.id,
      exit_reason: 'PROFIT_TARGET',
      profit_fraction,
      threshold: profitTargetFraction,
      timestamp: now.toISOString(),
    }));
    return { trigger: 'PROFIT_TARGET', metrics };
  } else {
    console.log('[closeRules] profit check', JSON.stringify({
      trade_id: trade.id,
      profit_fraction,
      threshold: profitTargetFraction,
      decision: 'SKIP',
      timestamp: now.toISOString(),
    }));
  }

  // 4) STOP_LOSS - close when loss_fraction >= threshold (percentage of max loss only)
  // Debit spreads: 0.50 (50%), Credit spreads: 0.10 (10%)
  // If the setting is negative (old pnl_fraction-based value), ignore it and use default
  // Note: isDebitSpread includes both BULL_CALL_DEBIT and BEAR_PUT_DEBIT
  const defaultStopLoss = isDebitSpread ? '0.50' : '0.10';
  const stopLossSetting = await getSetting(env, 'CLOSE_RULE_STOP_LOSS_FRACTION');
  let stopLossFraction: number;
  
  if (stopLossSetting) {
    const parsed = parseFloat(stopLossSetting);
    // If negative, it's the old pnl_fraction-based threshold - ignore and use default
    if (parsed < 0) {
      stopLossFraction = isDebitSpread ? 0.50 : 0.10;
    } else {
      stopLossFraction = parsed;
    }
  } else {
    stopLossFraction = isDebitSpread ? 0.50 : 0.10;
  }
  
  if (metrics.loss_fraction >= stopLossFraction) {
    console.log('[closeRules] stop-loss check', JSON.stringify({
      trade_id: trade.id,
      loss_fraction: metrics.loss_fraction,
      threshold: stopLossFraction,
      decision: 'TRIGGER',
      timestamp: now.toISOString(),
    }));
    console.log('[monitor][exit][triggered]', JSON.stringify({
      trade_id: trade.id,
      exit_reason: 'STOP_LOSS',
      loss_fraction: metrics.loss_fraction,
      threshold: stopLossFraction,
      timestamp: now.toISOString(),
    }));
    return { trigger: 'STOP_LOSS', metrics };
  } else {
    console.log('[closeRules] stop-loss check', JSON.stringify({
      trade_id: trade.id,
      loss_fraction: metrics.loss_fraction,
      threshold: stopLossFraction,
      decision: 'SKIP',
      timestamp: now.toISOString(),
    }));
  }

  // 5) IV_CRUSH_EXIT (IV dropped 15%+ and PnL >= +15%)
  // Only applies to credit spreads (short volatility structures)
  const isCreditSpread = trade.strategy === 'BULL_PUT_CREDIT' || trade.strategy === 'BEAR_CALL_CREDIT';
  
  if (isCreditSpread && trade.iv_entry && trade.iv_entry > 0) {
    // Use provided optionChain if available, otherwise fetch it
    let chainToUse = optionChain;
    if (!chainToUse) {
      const broker = new TradierClient(env);
      try {
        chainToUse = await broker.getOptionChain(trade.symbol, trade.expiration);
      } catch (error) {
        // If we can't fetch chain, skip IV crush check
        console.log('[close] iv_crush_skip', JSON.stringify({
          trade_id: trade.id,
          reason: 'Could not fetch option chain for IV check',
          error: error instanceof Error ? error.message : String(error),
        }));
        chainToUse = undefined;
      }
    }
    
    if (chainToUse) {
      // Determine option type based on strategy
      const optionType = trade.strategy === 'BEAR_CALL_CREDIT' ? 'call' : 'put';
      const shortOption = chainToUse.find(
        opt => opt.strike === trade.short_strike && opt.type === optionType
      );
      
      if (shortOption && shortOption.implied_volatility) {
        const iv_now = shortOption.implied_volatility;
        const iv_entry = trade.iv_entry;
        
        if (iv_now <= iv_entry * exitRules.ivCrushThreshold && profit_fraction >= exitRules.ivCrushMinPnL) {
          console.log('[monitor][exit][triggered]', JSON.stringify({
            trade_id: trade.id,
            exit_reason: 'IV_CRUSH_EXIT',
            profit_fraction,
            iv_entry,
            iv_now,
            iv_drop_pct: (iv_now / iv_entry - 1) * 100,
            threshold: exitRules.ivCrushThreshold,
            timestamp: now.toISOString(),
          }));
          return { trigger: 'IV_CRUSH_EXIT' as ExitTriggerType, metrics };
        }
      }
    }
  }

  // 6) TIME_EXIT - check AFTER profit target and stop loss
  // This ensures PnL-based exits take precedence over time-based exits
  const timeExitDte = metrics.dte;
  const etNow = toET(now);
  const timeStr = `${etNow.getHours().toString().padStart(2, '0')}:${etNow.getMinutes().toString().padStart(2, '0')}`;
  const timeExitCutoff = exitRules.timeExitCutoff; // e.g., "15:50"
  
  if (timeExitDte <= exitRules.timeExitDteThreshold && timeStr >= timeExitCutoff) {
    console.log('[monitor][exit][triggered]', JSON.stringify({
      trade_id: trade.id,
      exit_reason: 'TIME_EXIT',
      dte: timeExitDte,
      time: timeStr,
      cutoff: timeExitCutoff,
      timestamp: now.toISOString(),
    }));
    return { trigger: 'TIME_EXIT' as ExitTriggerType, metrics };
  }

  // 7) LOW_VALUE_CLOSE (credit spreads very cheap)
  // Only applies to credit spreads - for debits, low mark means near max loss, not profit
  const isDebitSpreadForLowValue = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
  
  if (!isDebitSpreadForLowValue) {
    const LOW_VALUE_CLOSE_THRESHOLD = parseFloat(
      (await getSetting(env, 'CLOSE_RULE_LOW_VALUE_CLOSE_THRESHOLD')) || '0.05'
    );
    if (metrics.current_mark <= LOW_VALUE_CLOSE_THRESHOLD) {
      console.log('[close] LOW_VALUE_CLOSE triggered', {
        trade_id: trade.id,
        current_mark: metrics.current_mark,
        threshold: LOW_VALUE_CLOSE_THRESHOLD,
      });
      return { trigger: 'LOW_VALUE_CLOSE' as ExitTriggerType, metrics };
    }
  }

  // 6) STRUCTURE_INVALID – negative or nonsensical pricing
  if (metrics.current_mark <= 0) {
    console.log('[close] STRUCTURE_INVALID triggered', {
      trade_id: trade.id,
      current_mark: metrics.current_mark,
    });
    return { trigger: 'EMERGENCY', metrics };
  }

  // No exit triggered - decision will be logged in [closeEval] above

  return { trigger: 'NONE', metrics };
}

/**
 * Check if emergency exit should trigger
 */
async function shouldTriggerEmergency(
  env: Env,
  metrics: MonitoringMetrics,
  liquiditySpreadThreshold: number,
  underlyingSpikeThreshold: number
): Promise<boolean> {
  // Liquidity collapse
  if (!metrics.liquidity_ok) {
    console.log('[close] EMERGENCY: liquidity collapse', JSON.stringify({
      liquidity_ok: metrics.liquidity_ok,
      threshold: liquiditySpreadThreshold,
    }));
    return true;
  }
  
  // Quote integrity failure
  if (!metrics.quote_integrity_ok) {
    console.log('[close] EMERGENCY: quote integrity failure', JSON.stringify({
      quote_integrity_ok: metrics.quote_integrity_ok,
    }));
    return true;
  }
  
  // Underlying spike > threshold in 15 seconds
  if (Math.abs(metrics.underlying_change_15s) > underlyingSpikeThreshold) {
    console.log('[close] EMERGENCY: underlying spike', JSON.stringify({
      underlying_change_15s: metrics.underlying_change_15s,
      threshold: underlyingSpikeThreshold,
    }));
    return true;
  }
  
  // Mark moves > 20% of max_profit in 10 seconds
  // TODO: Track mark history for this check
  
  return false;
}

/**
 * Create emergency metrics when data is missing
 */
function createEmergencyMetrics(trade: TradeRow, now: Date): MonitoringMetrics {
  return {
    current_mark: trade.entry_price || 0,
    unrealized_pnl: 0,
    pnl_fraction: 0,
    loss_fraction: 0,
    dte: computeDTE(trade.expiration, now),
    underlying_price: 0,
    underlying_change_1m: 0,
    underlying_change_15s: 0,
    liquidity_ok: false,
    quote_integrity_ok: false,
  };
}

/**
 * Compute underlying price changes (1m and 15s)
 * 
 * Uses stored price snapshots in settings table.
 * If no history exists, returns 0 (safe default).
 */
async function computeUnderlyingChanges(
  env: Env,
  tradeId: string,
  currentPrice: number,
  now: Date
): Promise<{ change_1m: number; change_15s: number }> {
  const priceKey1m = `PRICE_SNAP_${tradeId}_1M`;
  const priceKey15s = `PRICE_SNAP_${tradeId}_15S`;
  const timeKey1m = `PRICE_TIME_${tradeId}_1M`;
  const timeKey15s = `PRICE_TIME_${tradeId}_15S`;
  
  // Get stored prices
  const price1mAgo = await getSetting(env, priceKey1m);
  const price15sAgo = await getSetting(env, priceKey15s);
  const time1mAgo = await getSetting(env, timeKey1m);
  const time15sAgo = await getSetting(env, timeKey15s);
  
  // Compute 1m change
  let change_1m = 0;
  if (price1mAgo && time1mAgo) {
    const storedTime = new Date(time1mAgo);
    const timeDiff = (now.getTime() - storedTime.getTime()) / 1000; // seconds
    
    // Only use if within 90 seconds (allowing some tolerance)
    if (timeDiff >= 50 && timeDiff <= 90) {
      const storedPrice = parseFloat(price1mAgo);
      if (storedPrice > 0) {
        change_1m = (currentPrice - storedPrice) / storedPrice;
      }
    }
  }
  
  // Compute 15s change
  let change_15s = 0;
  if (price15sAgo && time15sAgo) {
    const storedTime = new Date(time15sAgo);
    const timeDiff = (now.getTime() - storedTime.getTime()) / 1000; // seconds
    
    // Only use if within 30 seconds (allowing some tolerance)
    if (timeDiff >= 10 && timeDiff <= 30) {
      const storedPrice = parseFloat(price15sAgo);
      if (storedPrice > 0) {
        change_15s = (currentPrice - storedPrice) / storedPrice;
      }
    }
  }
  
  // Update stored prices for next cycle
  // Store current price as 1m ago (will become 1m ago on next cycle)
  const price1mKey = `PRICE_SNAP_${tradeId}_1M_PREV`;
  await setSetting(env, price1mKey, currentPrice.toString());
  await setSetting(env, timeKey1m, now.toISOString());
  
  // Store current price as 15s ago
  await setSetting(env, priceKey15s, currentPrice.toString());
  await setSetting(env, timeKey15s, now.toISOString());
  
  // Rotate: move prev 1m to current 1m
  const prev1mPrice = await getSetting(env, price1mKey);
  if (prev1mPrice) {
    await setSetting(env, priceKey1m, prev1mPrice);
  }
  
  return { change_1m, change_15s };
}

/**
 * Repair portfolio: check structural integrity of all open spreads and close broken ones
 * 
 * This function is called:
 * 1. At the start of each monitor cycle (automatic repair)
 * 2. Via admin endpoint (manual repair)
 * 
 * For each OPEN spread:
 * - Run structural integrity check
 * - If broken, mark for immediate close with reason STRUCTURAL_BREAK
 */
export async function repairPortfolio(env: Env, now: Date): Promise<void> {
  const openTrades = await getOpenTrades(env);
  const broker = new TradierClient(env);
  
  let repairedCount = 0;
  let skippedNoEntryPrice = 0;
  let checkedCount = 0;
  
  for (const trade of openTrades) {
    // All trades are managed by Gekkoworks - check all of them
    // We can check structure even without entry_price
    if (!trade.entry_price || trade.entry_price <= 0) {
      skippedNoEntryPrice++;
    }
    
    checkedCount++;
    try {
      // Fetch option chain for structural check
      const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
      const integrityCheck = await checkStructuralIntegrity(env, trade, broker, optionChain);
      
      if (!integrityCheck.valid) {
        console.log('[repair] structural_break_detected', JSON.stringify({
          trade_id: trade.id,
          symbol: trade.symbol,
          expiration: trade.expiration,
          reason: integrityCheck.reason,
          details: integrityCheck.details,
        }));
        
        // Close the trade immediately via executeExitForTrade
        const { executeExitForTrade } = await import('./exits');
        const decision = {
          trigger: 'EMERGENCY' as const, // Structural break is an emergency
          metrics: {
            current_mark: 0,
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
        
        const exitResult = await executeExitForTrade(env, trade, decision, now);
        if (exitResult.success) {
          console.log('[repair] trade_closed', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            exit_reason: 'STRUCTURAL_BREAK',
          }));
          repairedCount++;
        } else {
          console.log('[repair] close_failed', JSON.stringify({
            trade_id: trade.id,
            symbol: trade.symbol,
            reason: exitResult.reason,
          }));
        }
      }
    } catch (error) {
      // If we can't check a trade, log but continue
      console.log('[repair] check_failed', JSON.stringify({
        trade_id: trade.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  
  // Always log repair summary, even if nothing was broken
  console.log('[repair] portfolio_repair_complete', JSON.stringify({
    total_open: openTrades.length,
    checked: checkedCount,
    skipped_no_entry_price: skippedNoEntryPrice,
    broken: repairedCount,
  }));
}

/**
 * Check structural integrity of a spread trade
 * 
 * Verifies:
 * 1. Strikes match pattern: long_strike === short_strike - 5
 * 2. Both legs exist in option chain
 * 3. Both legs exist in broker positions (Tradier)
 * 4. Quantities match (always 1 in v1)
 * 
 * Returns { valid: false, reason, details } if structural break detected.
 */
async function checkStructuralIntegrity(
  env: Env,
  trade: TradeRow,
  broker: TradierClient,
  optionChain: OptionQuote[]
): Promise<{ valid: boolean; reason?: string; details?: any }> {
  // Defensive check: strategy must be set
  if (!trade.strategy) {
    return {
      valid: false,
      reason: 'MISSING_STRATEGY',
      details: {
        note: 'Trade missing strategy field - cannot validate spread structure',
      },
    };
  }
  
  // Determine option type and strike relationship based on strategy
  // Each strategy has a specific strike pattern (matching lifecycle.validateSpreadInvariants):
  // - BULL_PUT_CREDIT: puts, long_strike = short_strike - width (short higher, long lower)
  // - BEAR_PUT_DEBIT: puts, long_strike = short_strike + width (long higher, short lower)
  // - BEAR_CALL_CREDIT: calls, long_strike = short_strike + width (short lower, long higher)
  // - BULL_CALL_DEBIT: calls, long_strike = short_strike - width (long lower, short higher)
  let optionType: 'call' | 'put';
  let expectedLongStrike: number;
  
  switch (trade.strategy) {
    case 'BULL_PUT_CREDIT':
      optionType = 'put';
      expectedLongStrike = trade.short_strike - trade.width;
      break;
    case 'BEAR_PUT_DEBIT':
      optionType = 'put';
      expectedLongStrike = trade.short_strike + trade.width;
      break;
    case 'BEAR_CALL_CREDIT':
      optionType = 'call';
      expectedLongStrike = trade.short_strike + trade.width;
      break;
    case 'BULL_CALL_DEBIT':
      optionType = 'call';
      expectedLongStrike = trade.short_strike - trade.width;
      break;
    default:
      // Fallback for unknown strategies
      console.warn('[monitor] unknown_strategy_for_validation', JSON.stringify({
        trade_id: trade.id,
        strategy: trade.strategy,
      }));
      optionType = 'put'; // Default fallback
      expectedLongStrike = trade.short_strike - trade.width; // Default to credit spread pattern
  }
  
  if (Math.abs(trade.long_strike - expectedLongStrike) > 0.01) {
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
      },
    };
  }
  
  // 2. Check both legs exist in option chain
  const shortOption = optionChain.find(
    opt => opt.strike === trade.short_strike && opt.type === optionType
  );
  const longOption = optionChain.find(
    opt => opt.strike === trade.long_strike && opt.type === optionType
  );
  
  if (!shortOption) {
    return {
      valid: false,
      reason: 'SHORT_LEG_MISSING_IN_CHAIN',
      details: {
        short_strike: trade.short_strike,
        expiration: trade.expiration,
        strategy: trade.strategy,
        option_type: optionType,
      },
    };
  }
  
  if (!longOption) {
    return {
      valid: false,
      reason: 'LONG_LEG_MISSING_IN_CHAIN',
      details: {
        long_strike: trade.long_strike,
        expiration: trade.expiration,
        strategy: trade.strategy,
        option_type: optionType,
      },
    };
  }
  
    // 3. Check both legs exist in broker positions
    try {
      // First, verify the entry order actually filled
      // If the order was never filled, the trade shouldn't be OPEN
      if (trade.broker_order_id_open) {
        try {
          const entryOrder = await broker.getOrder(trade.broker_order_id_open);
          if (entryOrder.status !== 'FILLED') {
            // Order was never filled - this is a data integrity issue
            // Don't trigger emergency exit, but log the issue
            console.error('[monitor] entry_order_not_filled', JSON.stringify({
              trade_id: trade.id,
              order_id: trade.broker_order_id_open,
              order_status: entryOrder.status,
              note: 'Trade marked OPEN but entry order was never filled',
            }));
            return {
              valid: false,
              reason: 'ENTRY_ORDER_NOT_FILLED',
              details: {
                order_id: trade.broker_order_id_open,
                order_status: entryOrder.status,
              },
            };
          }
        } catch (orderError) {
          // If we can't check order status, continue with position check
          console.warn('[monitor] could_not_verify_order', JSON.stringify({
            trade_id: trade.id,
            order_id: trade.broker_order_id_open,
            error: orderError instanceof Error ? orderError.message : String(orderError),
          }));
        }
      }
      
      const positions = await broker.getPositions();
      
      // Find positions matching our legs
      const shortPosition = positions.find(
        pos => pos.symbol === shortOption.symbol
      );
      const longPosition = positions.find(
        pos => pos.symbol === longOption.symbol
      );
      
      // Check if trade was recently opened (within last 2 minutes)
      // Positions might not be synced yet, so we'll be lenient
      const openedAt = trade.opened_at ? new Date(trade.opened_at) : null;
      const recentlyOpened = openedAt && (Date.now() - openedAt.getTime()) < 2 * 60 * 1000; // 2 minutes
      
      if (!shortPosition) {
        // If recently opened, log warning but don't fail validation
        if (recentlyOpened) {
          console.warn('[monitor] short_position_not_found_yet', JSON.stringify({
            trade_id: trade.id,
            short_option_symbol: shortOption.symbol,
            short_strike: trade.short_strike,
            strategy: trade.strategy,
            option_type: optionType,
            opened_at: trade.opened_at,
            note: 'Trade recently opened, position may not be synced yet',
          }));
          // Return valid but with a note - we'll check again next cycle
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
        console.warn('[monitor] long_position_not_found_yet', JSON.stringify({
          trade_id: trade.id,
          long_option_symbol: longOption.symbol,
          long_strike: trade.long_strike,
          strategy: trade.strategy,
          option_type: optionType,
          opened_at: trade.opened_at,
          note: 'Trade recently opened, position may not be synced yet',
        }));
        // Return valid but with a note - we'll check again next cycle
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
    
    // 4. Check quantities match (must be equal, and match trade.quantity)
    // For a bull put credit spread:
    // - Short put should have negative quantity (sold)
    // - Long put should have positive quantity (bought)
    // Both must have the same absolute quantity, and match trade.quantity
    const shortQty = Math.abs(shortPosition.quantity);
    const longQty = Math.abs(longPosition.quantity);
    // Use configurable default if trade.quantity is not set
    const defaultQuantity = await getDefaultTradeQuantity(env);
    const expectedQuantity = trade.quantity ?? defaultQuantity;
    
    if (shortQty !== longQty || shortQty < 1) {
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
    
    // Also check that Tradier quantities are at least the trade quantity
    // Note: Tradier quantity may be higher if multiple trades share the same positions
    // We only fail if Tradier has LESS than expected (data integrity issue)
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
      console.warn('[monitor] tradier_quantity_greater_than_trade', JSON.stringify({
        trade_id: trade.id,
        trade_quantity: expectedQuantity,
        tradier_quantity: shortQty,
        note: 'Multiple trades may share these positions',
      }));
    }
    
    // All checks passed
    return { valid: true };
  } catch (error) {
    // If we can't fetch positions, log but don't fail (might be transient)
    console.log('[monitor][structural_check_error]', JSON.stringify({
      trade_id: trade.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    // Return valid=true to avoid false positives from transient errors
    return { valid: true };
  }
}

