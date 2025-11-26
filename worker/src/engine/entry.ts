/**
 * SAS v1 Entry Engine
 * 
 * Implements entry-rules.md and execution.md exactly.
 * 
 * Responsibilities:
 * - Validate proposals
 * - Check risk gates
 * - Compute limit price
 * - Place orders via broker
 * - Poll for fills
 * - Transition to OPEN state
 */

import type { Env } from '../env';
import type { EntryAttemptResult, TradeRow, BrokerOrderStatus, SpreadLeg } from '../types';
import { TradierClient } from '../broker/tradierClient';
import { getLatestProposal, updateProposalStatus, insertSystemLog } from '../db/queries';
import { insertTrade } from '../db/queries';
import { canOpenNewTrade } from '../core/risk';
import { isMarketHours } from '../core/time';
import { getTradingMode, getStrategyThresholds } from '../core/config';
import { getSetting } from '../db/queries';
import { markTradeOpen, markTradeCancelled } from './lifecycle';
import { notifyEntrySubmitted } from '../notifications/telegram';

const MAX_PROPOSAL_AGE_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FILL_WAIT_MS = 30 * 1000; // 30 seconds total timeout (per Tradier-first spec)
const POLL_INTERVAL_MS = 2 * 1000; // 2 seconds between polls (per Tradier-first spec)
const ENTRY_SLIPPAGE = 0.02;

/**
 * Poll order until filled, with strict timeout
 * 
 * Per Tradier-first spec:
 * - Poll every 2 seconds
 * - Timeout after 30 seconds
 * - Return fill status and reason
 */
async function pollOrderUntilFilled(
  env: Env,
  broker: TradierClient,
  orderId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<{ filled: boolean; reason: string; fillPrice?: number }> {
  const startTime = Date.now();
  let lastStatus: BrokerOrderStatus | null = null;
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const order = await broker.getOrder(orderId);
      lastStatus = order.status;
      
      if (order.status === 'FILLED') {
        if (order.avg_fill_price !== null && order.avg_fill_price > 0) {
          return {
            filled: true,
            reason: 'Order filled',
            fillPrice: order.avg_fill_price,
          };
        } else {
          return {
            filled: false,
            reason: 'Order filled but fill price missing',
          };
        }
      } else if (order.status === 'CANCELLED' || order.status === 'REJECTED' || order.status === 'EXPIRED') {
        return {
          filled: false,
          reason: `Order ${order.status.toLowerCase()}`,
        };
      }
      
      // Status is OPEN or NEW - continue polling
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } catch (error) {
      // Broker error - log but continue polling (might be transient)
      console.warn('[entry] poll error, continuing', JSON.stringify({
        orderId,
        error: error instanceof Error ? error.message : String(error),
      }));
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }
  
  // Timeout reached
  return {
    filled: false,
    reason: `Timeout after ${timeoutMs}ms, last status: ${lastStatus || 'unknown'}`,
  };
}

/**
 * Attempt entry for the latest proposal
 * 
 * Per system-interfaces.md:
 * export async function attemptEntryForLatestProposal(
 *   env: Env,
 *   now: Date
 * ): Promise<EntryAttemptResult>;
 */
export async function attemptEntryForLatestProposal(
  env: Env,
  now: Date
): Promise<EntryAttemptResult> {
  try {
    // 1. Get latest proposal
    const proposal = await getLatestProposal(env);
    if (!proposal) {
      console.log('[entry][rejected]', JSON.stringify({
        reason: 'No proposal available',
      }));
      return { trade: null, reason: 'No proposal available' };
    }
    
    console.log('[entry][start]', JSON.stringify({
      proposal_id: proposal.id,
      symbol: proposal.symbol,
      strategy: proposal.strategy,
      score: proposal.score,
      short_strike: proposal.short_strike,
      long_strike: proposal.long_strike,
      expiration: proposal.expiration,
    }));
    
    // 2. Validate proposal
    const validation = await validateProposal(env, proposal, now);
    if (!validation.valid) {
      console.log('[entry][validation][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: validation.reason,
      }));
      await updateProposalStatus(env, proposal.id, 'INVALIDATED');
      return { trade: null, reason: validation.reason };
    }
    
    // 3. Check risk gates
    // NOTE: Risk gate behavior - which gates should invalidate vs leave READY:
    // - Structural gates (per-trade max loss, daily risk cap, exposure governors): Leave READY
    //   These may pass on a later run if conditions change (e.g., other trades close)
    // - Temporary gates (MAX_NEW_TRADES_PER_DAY, auto-mode disabled): Leave READY
    //   These are time-based and will pass on a later cycle
    // - Data/validation gates (validateProposal, price drift): INVALIDATE
    //   These indicate the proposal itself is no longer valid
    // - Regime confidence: Leave READY (market conditions may improve)
    if (!(await canOpenNewTrade(env, now))) {
      console.log('[entry][risk_gates][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: 'Risk gates prevent new trade',
      }));
      // Leave proposal as READY - may pass on next cycle if conditions change
      return { trade: null, reason: 'Risk gates prevent new trade' };
    }
    
    // 3.0. Check regime confidence (prevent trading in choppy/uncertain conditions)
    const { computeSMA20 } = await import('../core/trend');
    const { isRegimeConfidenceSufficient } = await import('../core/regimeConfidence');
    const brokerForConfidence = new TradierClient(env);
    const underlying = await brokerForConfidence.getUnderlyingQuote(proposal.symbol);
    const sma20 = await computeSMA20(env, proposal.symbol);
    
    if (sma20 !== null) {
      const priceDiff = Math.abs(underlying.last - sma20);
      const regimeConfidence = priceDiff / underlying.last;
      
      if (!isRegimeConfidenceSufficient(regimeConfidence)) {
        console.log('[entry][regime-confidence][rejected]', JSON.stringify({
          proposal_id: proposal.id,
          symbol: proposal.symbol,
          price: underlying.last,
          sma20,
          regime_confidence: regimeConfidence,
          regime_confidence_percent: (regimeConfidence * 100).toFixed(3),
          reason: 'Regime confidence too low - market may be choppy',
        }));
        return { trade: null, reason: `Regime confidence too low (${(regimeConfidence * 100).toFixed(2)}%) - trading paused to avoid chop` };
      }
    }
    
    // 3.1. Validate risk caps with proposal's estimated max_loss
    // For credit spreads: max_loss = width - entry_price
    // For debit spreads: max_loss = debit (entry_price)
    const quantity = proposal.quantity || 1;
    
    // 3.1a. Check maximum quantity per trade (safety limit)
    const maxTradeQuantity = parseInt(
      (await getSetting(env, 'MAX_TRADE_QUANTITY')) || '10',
      10
    ) || 10; // Default to 10 contracts max per trade
    if (quantity > maxTradeQuantity) {
      console.log('[entry][risk][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: `Trade quantity (${quantity}) exceeds MAX_TRADE_QUANTITY (${maxTradeQuantity})`,
        quantity,
        max_trade_quantity: maxTradeQuantity,
      }));
      await updateProposalStatus(env, proposal.id, 'INVALIDATED');
      return { trade: null, reason: `Quantity ${quantity} exceeds maximum ${maxTradeQuantity}` };
    }
    
    const isDebitSpreadForRisk = proposal.strategy === 'BULL_CALL_DEBIT' || proposal.strategy === 'BEAR_PUT_DEBIT';
    const estimatedMaxLossPerSpread = isDebitSpreadForRisk 
      ? Math.abs(proposal.credit_target) // For debit, credit_target is negative (debit paid)
      : proposal.width - proposal.credit_target; // For credit, max_loss = width - credit
    const estimatedMaxLossTotal = estimatedMaxLossPerSpread * quantity;
    
    // Per-trade max loss cap
    const { validatePerTradeMaxLoss } = await import('../core/risk');
    const perTradeCheck = await validatePerTradeMaxLoss(env, estimatedMaxLossTotal, isDebitSpreadForRisk);
    if (!perTradeCheck.valid) {
      console.log('[entry][risk][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: perTradeCheck.reason,
        estimated_max_loss: estimatedMaxLossTotal,
      }));
      return { trade: null, reason: perTradeCheck.reason || 'Per-trade max loss exceeded' };
    }
    
    // Daily new-risk cap
    const { validateDailyNewRiskCap } = await import('../core/risk');
    const dailyNewRiskCheck = await validateDailyNewRiskCap(env, now, estimatedMaxLossTotal);
    if (!dailyNewRiskCheck.valid) {
      console.log('[entry][risk][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: dailyNewRiskCheck.reason,
        estimated_max_loss: estimatedMaxLossTotal,
      }));
      return { trade: null, reason: dailyNewRiskCheck.reason || 'Daily new risk cap exceeded' };
    }
    
    // Exposure governors (for directional strategies)
    const isBullishStrategy = proposal.strategy === 'BULL_PUT_CREDIT' || proposal.strategy === 'BULL_CALL_DEBIT';
    const isBearishStrategy = proposal.strategy === 'BEAR_CALL_CREDIT' || proposal.strategy === 'BEAR_PUT_DEBIT';
    
    if (isBullishStrategy) {
      const { validateGlobalBullRiskCap, validateBullTradeCounts } = await import('../core/risk');
      
      // Check global bull risk cap
      const bullRiskCheck = await validateGlobalBullRiskCap(env, estimatedMaxLossTotal, isDebitSpreadForRisk);
      if (!bullRiskCheck.valid) {
        console.log('[entry][risk][bull_governor][rejected]', JSON.stringify({
          proposal_id: proposal.id,
          strategy: proposal.strategy,
          reason: bullRiskCheck.reason,
          estimated_max_loss: estimatedMaxLossTotal,
        }));
        return { trade: null, reason: bullRiskCheck.reason || 'Global bull risk cap exceeded' };
      }
      
      // Check bull trade count limits
      const bullCountCheck = await validateBullTradeCounts(env, isDebitSpreadForRisk);
      if (!bullCountCheck.valid) {
        console.log('[entry][risk][bull_governor][rejected]', JSON.stringify({
          proposal_id: proposal.id,
          strategy: proposal.strategy,
          reason: bullCountCheck.reason,
        }));
        return { trade: null, reason: bullCountCheck.reason || 'Bull trade count limit exceeded' };
      }
      
      // Log current bull exposure for transparency
      const { computeBullishExposure } = await import('../core/risk');
      const exposure = await computeBullishExposure(env);
      console.log('[entry][risk][bull_governor][passed]', JSON.stringify({
        proposal_id: proposal.id,
        strategy: proposal.strategy,
        estimated_max_loss: estimatedMaxLossTotal,
        is_debit: isDebitSpreadForRisk,
        current_bull_exposure: {
          credit_risk: exposure.bull_credit_risk,
          debit_risk: exposure.bull_debit_risk,
          total_weighted_risk: exposure.bull_total_risk,
          trade_count: exposure.bull_trade_count,
          debit_count: exposure.debit_trade_count,
        },
      }));
    }
    
    // Daily realized loss cap
    const { validateDailyRealizedLossCap } = await import('../core/risk');
    const dailyLossCheck = await validateDailyRealizedLossCap(env, now);
    if (!dailyLossCheck.valid) {
      console.log('[entry][risk][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: dailyLossCheck.reason,
      }));
      return { trade: null, reason: dailyLossCheck.reason || 'Daily realized loss cap exceeded' };
    }
    
    // Concentration caps
    const { validateUnderlyingConcentrationCap, validateExpiryConcentrationCap } = await import('../core/risk');
    const underlyingCheck = await validateUnderlyingConcentrationCap(env, proposal.symbol, estimatedMaxLossTotal);
    if (!underlyingCheck.valid) {
      console.log('[entry][risk][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: underlyingCheck.reason,
        symbol: proposal.symbol,
        estimated_max_loss: estimatedMaxLossTotal,
      }));
      return { trade: null, reason: underlyingCheck.reason || 'Underlying concentration cap exceeded' };
    }
    
    const expiryCheck = await validateExpiryConcentrationCap(env, proposal.symbol, proposal.expiration, estimatedMaxLossTotal);
    if (!expiryCheck.valid) {
      console.log('[entry][risk][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: expiryCheck.reason,
        symbol: proposal.symbol,
        expiration: proposal.expiration,
        estimated_max_loss: estimatedMaxLossTotal,
      }));
      return { trade: null, reason: expiryCheck.reason || 'Expiry concentration cap exceeded' };
    }
    
    // 3.5. Check exposure caps (before auto mode check)
    const { getOpenTrades } = await import('../db/queries');
    const openTrades = await getOpenTrades(env);
    
    // Global max open spreads
    const maxOpenSpreadsGlobal = parseInt(
      (await getSetting(env, 'MAX_OPEN_SPREADS_GLOBAL')) || '10'
    );
    if (openTrades.length >= maxOpenSpreadsGlobal) {
      console.log('[auto][skip]', JSON.stringify({
        reason: 'exposure limit hit',
        limit_type: 'MAX_OPEN_SPREADS_GLOBAL',
        current_count: openTrades.length,
        max_allowed: maxOpenSpreadsGlobal,
        proposal_id: proposal.id,
      }));
      return { trade: null, reason: `Max open spreads (${maxOpenSpreadsGlobal}) reached` };
    }
    
    // Per-symbol max open spreads
    const maxOpenSpreadsPerSymbol = parseInt(
      (await getSetting(env, 'MAX_OPEN_SPREADS_PER_SYMBOL')) || '5'
    );
    const openSpreadsForSymbol = openTrades.filter(t => t.symbol === proposal.symbol).length;
    if (openSpreadsForSymbol >= maxOpenSpreadsPerSymbol) {
      console.log('[auto][skip]', JSON.stringify({
        reason: 'exposure limit hit',
        limit_type: 'MAX_OPEN_SPREADS_PER_SYMBOL',
        symbol: proposal.symbol,
        current_count: openSpreadsForSymbol,
        max_allowed: maxOpenSpreadsPerSymbol,
        proposal_id: proposal.id,
      }));
      return { trade: null, reason: `Max open spreads for ${proposal.symbol} (${maxOpenSpreadsPerSymbol}) reached` };
    }
    
    // Max new trades per day
    const maxNewTradesPerDay = parseInt(
      (await getSetting(env, 'MAX_NEW_TRADES_PER_DAY')) || '5'
    );
    const { getTradesToday } = await import('../db/queries');
    const tradesToday = await getTradesToday(env, now);
    const openedToday = tradesToday.filter(t => 
      t.status === 'OPEN' || 
      (t.opened_at && new Date(t.opened_at).toDateString() === now.toDateString())
    ).length;
    if (openedToday >= maxNewTradesPerDay) {
      console.log('[auto][skip]', JSON.stringify({
        reason: 'exposure limit hit',
        limit_type: 'MAX_NEW_TRADES_PER_DAY',
        current_count: openedToday,
        max_allowed: maxNewTradesPerDay,
        proposal_id: proposal.id,
      }));
      return { trade: null, reason: `Max new trades per day (${maxNewTradesPerDay}) reached` };
    }
    
    // 4. Check market hours
    if (!isMarketHours(now)) {
      console.log('[entry][market_hours][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        reason: 'Outside market hours',
        now: now.toISOString(),
      }));
      return { trade: null, reason: 'Outside market hours' };
    }
    
    // 4.5. Check auto mode (must be enabled to place orders)
    const { isAutoModeEnabled, getTradingMode } = await import('../core/config');
    const tradingMode = await getTradingMode(env);
    const autoModeEnabled = await isAutoModeEnabled(env);
    
    if (!autoModeEnabled) {
      console.log('[auto][skip]', JSON.stringify({
        env: tradingMode,
        reason: 'auto_mode disabled for env',
        proposal_id: proposal.id,
      }));
      return { trade: null, reason: `Auto mode disabled for ${tradingMode} - orders require manual approval` };
    }
    
    // 4.6. Check proposal score meets minimum threshold
    const { getMinScore } = await import('../core/config');
    const rawMinScore = await getMinScore(env);
    // Normalize minScore to 0-1 scale (proposal.score is 0-1, but getMinScore returns 0-100)
    const effectiveMinScore = rawMinScore > 1 ? rawMinScore / 100 : rawMinScore;
    
    if (proposal.score < effectiveMinScore) {
      console.log('[auto][skip]', JSON.stringify({
        proposal_id: proposal.id,
        score: proposal.score,
        raw_min_score: rawMinScore,
        effective_min_score: effectiveMinScore,
        reason: 'score below threshold',
      }));
      return { trade: null, reason: `Proposal score ${proposal.score} below minimum ${effectiveMinScore}` };
    }
    
    // 5. Price drift check: re-fetch quotes, re-validate credit & delta
    const broker = new TradierClient(env);
    const thresholds = await getStrategyThresholds(env);
    const { minCreditFraction, minDelta, maxDelta } = thresholds;
    const minCredit = proposal.width * minCreditFraction;
    
    const priceDriftCheck = await checkPriceDrift(broker, proposal, minCredit, minDelta, maxDelta);
    if (!priceDriftCheck.valid) {
      console.log('[entry][price_drift_check][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        symbol: proposal.symbol,
        strategy: proposal.strategy,
        reason: priceDriftCheck.reason,
        minCredit,
        minDelta,
        maxDelta,
      }));
      await updateProposalStatus(env, proposal.id, 'INVALIDATED');
      return { trade: null, reason: priceDriftCheck.reason };
    }
    
    console.log('[entry][price_drift_check][passed]', JSON.stringify({
      proposal_id: proposal.id,
      symbol: proposal.symbol,
      strategy: proposal.strategy,
      credit: priceDriftCheck.credit,
      delta: priceDriftCheck.delta,
    }));
    
    // Determine option type based on strategy
    const optionType = (proposal.strategy === 'BEAR_CALL_CREDIT' || proposal.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
    const shortOption = optionType === 'put' ? priceDriftCheck.shortPut : priceDriftCheck.shortCall;
    const longOption = optionType === 'put' ? priceDriftCheck.longPut : priceDriftCheck.longCall;
    
    if (!shortOption || !longOption) {
      console.log('[entry][option_legs_missing][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        symbol: proposal.symbol,
        strategy: proposal.strategy,
        option_type: optionType,
        short_option_found: !!shortOption,
        long_option_found: !!longOption,
        short_put: !!priceDriftCheck.shortPut,
        long_put: !!priceDriftCheck.longPut,
        short_call: !!priceDriftCheck.shortCall,
        long_call: !!priceDriftCheck.longCall,
        reason: 'Cannot find option legs in chain after price drift check',
      }));
      await updateProposalStatus(env, proposal.id, 'INVALIDATED');
      return { trade: null, reason: 'Cannot find option legs in chain' };
    }
    
    // 6. Compute limit price
    const isDebitSpreadForLimit = proposal.strategy === 'BULL_CALL_DEBIT' || proposal.strategy === 'BEAR_PUT_DEBIT';
    const limitPrice = computeLimitPrice(shortOption.bid, longOption.ask, isDebitSpreadForLimit);
    console.log('[entry][limit_price]', JSON.stringify({
      proposal_id: proposal.id,
      symbol: proposal.symbol,
      strategy: proposal.strategy,
      is_debit_spread: isDebitSpreadForLimit,
      short_bid: shortOption.bid,
      long_ask: longOption.ask,
      limit_price: limitPrice,
    }));
    // Note: computeLimitPrice already clamps to [0.60, 3.00], so this check is redundant
    // Keeping for defensive programming and explicit logging
    if (limitPrice < 0.60 || limitPrice > 3.00) {
      console.log('[entry][limit_price][rejected]', JSON.stringify({
        proposal_id: proposal.id,
        limit_price: limitPrice,
        reason: 'Limit price out of bounds [0.60, 3.00]',
      }));
      return { trade: null, reason: `Limit price ${limitPrice} out of bounds` };
    }
    
    // 8. Check trading mode (already fetched above)
    if (tradingMode === 'DRY_RUN') {
      // DRY_RUN mode - log but do not place order
      console.log(`[DRY_RUN] Would place spread order:`, {
        symbol: proposal.symbol,
        expiration: proposal.expiration,
        strategy: proposal.strategy,
        short_strike: proposal.short_strike,
        long_strike: proposal.long_strike,
        limit_price: limitPrice,
        short_option_symbol: shortOption.symbol,
        long_option_symbol: longOption.symbol,
      });
      
      // In DRY_RUN, we don't create a trade row - just log the proposal
      await updateProposalStatus(env, proposal.id, 'CONSUMED');
      return { trade: null, reason: 'DRY_RUN mode - order not placed' };
    }
    
    // 9. Place order (SANDBOX_PAPER or LIVE)
    // Determine if this is a debit spread
    const isDebitSpread = proposal.strategy === 'BULL_CALL_DEBIT' || proposal.strategy === 'BEAR_PUT_DEBIT';
    
    // For credit spreads (BULL_PUT_CREDIT, BEAR_CALL_CREDIT):
    //   Entry: sell_to_open short, buy_to_open long
    // For debit spreads (BULL_CALL_DEBIT, BEAR_PUT_DEBIT):
    //   Entry: buy_to_open long, sell_to_open short
    // So for credit spreads: leg[0] = short (sell_to_open), leg[1] = long (buy_to_open)
    // For debit spreads: leg[0] = long (buy_to_open), leg[1] = short (sell_to_open)
    
    let leg0: SpreadLeg;
    let leg1: SpreadLeg;
    
    if (isDebitSpread) {
      // Debit spread entry: buy_to_open long, sell_to_open short
      leg0 = {
        option_symbol: longOption.symbol,
        side: 'buy_to_open' as const,
        quantity: proposal.quantity ?? 1,
      };
      leg1 = {
        option_symbol: shortOption.symbol,
        side: 'sell_to_open' as const,
        quantity: proposal.quantity ?? 1,
      };
    } else {
      // Credit spread entry: sell_to_open short, buy_to_open long
      leg0 = {
        option_symbol: shortOption.symbol,
        side: 'sell_to_open' as const,
        quantity: proposal.quantity ?? 1,
      };
      leg1 = {
        option_symbol: longOption.symbol,
        side: 'buy_to_open' as const,
        quantity: proposal.quantity ?? 1,
      };
    }
    
    const orderDetails = {
      symbol: proposal.symbol,
      expiration: proposal.expiration,
      strategy: proposal.strategy,
      is_debit_spread: isDebitSpread,
      short_strike: proposal.short_strike,
      long_strike: proposal.long_strike,
      limit_price: limitPrice,
      short_option_symbol: shortOption.symbol,
      long_option_symbol: longOption.symbol,
      leg0: { option_symbol: leg0.option_symbol, side: leg0.side },
      leg1: { option_symbol: leg1.option_symbol, side: leg1.side },
    };
    console.log('[entry] placing order', JSON.stringify(orderDetails));
    
    // Also save to system_logs for debug endpoint
    await insertSystemLog(env, 'entry', '[entry] placing order', JSON.stringify(orderDetails));
    
    const order = await broker.placeSpreadOrder({
      symbol: proposal.symbol,
      side: 'ENTRY',
      limit_price: limitPrice,
      legs: [leg0, leg1],
      tag: 'GEKKOWORKS-ENTRY',
      strategy: proposal.strategy,
    });
    
    console.log('[entry] order placed successfully', JSON.stringify({
      orderId: order.id,
      status: order.status,
    }));
    
    // 9.5. Poll for fill with strict timeout (per Tradier-first spec)
    // Poll every 2s, timeout after 30s, cancel on timeout
    const pollResult = await pollOrderUntilFilled(
      env,
      broker,
      order.id,
      MAX_FILL_WAIT_MS,
      POLL_INTERVAL_MS
    );
    
    if (!pollResult.filled) {
      // Timeout or error - cancel order and mark trade as FAILED
      try {
        await broker.cancelOrder(order.id);
        console.log('[entry] order cancelled due to timeout', JSON.stringify({
          orderId: order.id,
          reason: pollResult.reason,
        }));
      } catch (cancelError) {
        console.error('[entry] failed to cancel order', JSON.stringify({
          orderId: order.id,
          error: cancelError instanceof Error ? cancelError.message : String(cancelError),
        }));
      }
      
      // Create trade row with FAILED status
      const failedTrade: Omit<TradeRow, 'created_at' | 'updated_at'> = {
        id: crypto.randomUUID(),
        proposal_id: proposal.id,
        symbol: proposal.symbol,
        expiration: proposal.expiration,
        short_strike: proposal.short_strike,
        long_strike: proposal.long_strike,
        width: proposal.width,
        quantity: proposal.quantity ?? 1,
        entry_price: null,
        exit_price: null,
        max_profit: null,
        max_loss: null,
        status: 'CANCELLED',
        exit_reason: (pollResult.reason || 'ENTRY_TIMEOUT') as any, // Entry failures use string reasons, not ExitReason enum
        broker_order_id_open: order.id,
        broker_order_id_close: null,
        opened_at: null,
        closed_at: null,
        realized_pnl: null,
        strategy: proposal.strategy,
      };
      
      const persistedTrade = await insertTrade(env, failedTrade);
      await updateProposalStatus(env, proposal.id, 'CONSUMED');
      
      return {
        trade: persistedTrade,
        reason: `Order timeout: ${pollResult.reason}`,
      };
    }
    
    // Order filled - get final order details and re-sync from Tradier
    const finalOrder = await broker.getOrder(order.id);
    if (!finalOrder.avg_fill_price || finalOrder.avg_fill_price <= 0) {
      // Data error - mark as failed
      const failedTrade: Omit<TradeRow, 'created_at' | 'updated_at'> = {
        id: crypto.randomUUID(),
        proposal_id: proposal.id,
        symbol: proposal.symbol,
        expiration: proposal.expiration,
        short_strike: proposal.short_strike,
        long_strike: proposal.long_strike,
        width: proposal.width,
        quantity: proposal.quantity ?? 1,
        entry_price: null,
        exit_price: null,
        max_profit: null,
        max_loss: null,
        status: 'CANCELLED',
        exit_reason: 'FILL_PRICE_MISSING' as any, // Entry failure reason, not ExitReason enum
        broker_order_id_open: order.id,
        broker_order_id_close: null,
        opened_at: null,
        closed_at: null,
        realized_pnl: null,
        strategy: proposal.strategy,
      };
      
      const persistedTrade = await insertTrade(env, failedTrade);
      await updateProposalStatus(env, proposal.id, 'CONSUMED');
      
      return {
        trade: persistedTrade,
        reason: 'Order filled but fill price missing',
      };
    }
    
    const filledQuantity =
      finalOrder.filled_quantity && finalOrder.filled_quantity > 0
        ? finalOrder.filled_quantity
        : (proposal.quantity ?? 1);
    
    // Immediately re-sync from Tradier before marking trade OPEN (per spec)
    console.log('[entry] order filled, re-syncing from Tradier', JSON.stringify({
      orderId: order.id,
      fillPrice: finalOrder.avg_fill_price,
    }));
    
    const { syncPortfolioFromTradier } = await import('./portfolioSync');
    const { syncOrdersFromTradier } = await import('./orderSync');
    const { syncBalancesFromTradier } = await import('./balancesSync');
    
    await syncPortfolioFromTradier(env);
    await syncOrdersFromTradier(env);
    await syncBalancesFromTradier(env);
    
    // 10. Create trade row with ENTRY_PENDING status (will be marked OPEN below)
    const trade: Omit<TradeRow, 'created_at' | 'updated_at'> = {
      id: crypto.randomUUID(),
      proposal_id: proposal.id,
      symbol: proposal.symbol,
      expiration: proposal.expiration,
      short_strike: proposal.short_strike,
      long_strike: proposal.long_strike,
      width: proposal.width,
      quantity: filledQuantity,
      entry_price: null, // Will be set by markTradeOpen
      exit_price: null,
      max_profit: null, // Will be calculated by markTradeOpen
      max_loss: null, // Will be calculated by markTradeOpen
      status: 'ENTRY_PENDING',
      exit_reason: null,
      broker_order_id_open: order.id,
      broker_order_id_close: null,
      opened_at: null,
      closed_at: null,
      realized_pnl: null,
      strategy: proposal.strategy,
    };
    
    const persistedTrade = await insertTrade(env, trade);
    console.log('[entry] trade inserted, marking as OPEN', JSON.stringify({
      id: persistedTrade.id,
      orderId: order.id,
      fillPrice: finalOrder.avg_fill_price,
    }));
    
    // Get IV at entry for IV crush exit logic
    let ivEntry: number | null = null;
    try {
      const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
      // Determine option type based on strategy
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      const shortOption = optionChain.find(
        opt => opt.strike === trade.short_strike && opt.type === optionType
      );
      if (shortOption && shortOption.implied_volatility) {
        ivEntry = shortOption.implied_volatility;
      }
    } catch (error) {
      // If we can't fetch IV, log but don't fail
      console.log('[entry] iv_fetch_failed', JSON.stringify({
        trade_id: persistedTrade.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    
    // Mark trade as OPEN with fill price from Tradier
    const openedTrade = await markTradeOpen(
      env,
      persistedTrade.id,
      finalOrder.avg_fill_price,
      now,
      ivEntry
    );
    
    await notifyEntrySubmitted(env, tradingMode, openedTrade, limitPrice);
    
    // 11. Mark proposal as consumed
    await updateProposalStatus(env, proposal.id, 'CONSUMED');
    
    return { trade: openedTrade };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[entry] attemptEntryForLatestProposal error', JSON.stringify({
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    }));
    return {
      trade: null,
      reason: errorMessage,
    };
  }
}

/**
 * Check pending entries and update status
 * 
 * Per system-interfaces.md:
 * export async function checkPendingEntries(
 *   env: Env,
 *   now: Date
 * ): Promise<void>;
 */
export async function checkPendingEntries(
  env: Env,
  now: Date
): Promise<void> {
  const { getTradesByStatus } = await import('../db/queries');
  const pendingTrades = await getTradesByStatus(env, 'ENTRY_PENDING');
  
  if (pendingTrades.length === 0) {
    return;
  }
  
  const broker = new TradierClient(env);
  
  for (const trade of pendingTrades) {
    if (!trade.broker_order_id_open) {
      await markTradeCancelled(env, trade.id, 'Missing broker order ID');
      continue;
    }
    
    // Check order age
    const tradeAge = now.getTime() - new Date(trade.created_at).getTime();
    if (tradeAge > MAX_FILL_WAIT_MS) {
      // Timeout - cancel broker order first, then mark trade as cancelled
      try {
        await broker.cancelOrder(trade.broker_order_id_open);
        console.log('[entry][pending][cancelled]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_open,
          reason: 'Entry timeout - cancelled broker order',
        }));
      } catch (error) {
        // Log but continue - order may already be filled/cancelled
        console.warn('[entry][pending][cancel_failed]', JSON.stringify({
          trade_id: trade.id,
          order_id: trade.broker_order_id_open,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      await markTradeCancelled(env, trade.id, 'Entry timeout - no fill');
      continue;
    }
    
    try {
      const order = await broker.getOrder(trade.broker_order_id_open);
      
      if (order.status === 'FILLED') {
        if (order.avg_fill_price === null) {
          // Data error - mark cancelled
          await markTradeCancelled(env, trade.id, 'Fill price missing');
          continue;
        }
        
        // Get IV at entry for IV crush exit logic
        // Fetch option chain to get current IV
        // Note: broker already instantiated at function start, no need to recreate
        let ivEntry: number | null = null;
        try {
          const optionChain = await broker.getOptionChain(trade.symbol, trade.expiration);
          // Determine option type based on strategy
          const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
          const shortOption = optionChain.find(
            opt => opt.strike === trade.short_strike && opt.type === optionType
          );
          if (shortOption && shortOption.implied_volatility) {
            ivEntry = shortOption.implied_volatility;
          }
        } catch (error) {
          // If we can't fetch IV, log but don't fail
          console.log('[entry] iv_fetch_failed', JSON.stringify({
            trade_id: trade.id,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        
        // Mark as open (with IV if available)
        await markTradeOpen(env, trade.id, order.avg_fill_price, now, ivEntry);
      } else if (order.status === 'CANCELLED' || order.status === 'REJECTED' || order.status === 'EXPIRED') {
        await markTradeCancelled(env, trade.id, `Order ${order.status.toLowerCase()}`);
      }
      // If status is OPEN or NEW, continue waiting
    } catch (error) {
      // Broker error - log but don't cancel yet (might be transient)
      // Will be handled on next cycle or timeout
      continue;
    }
  }
}

/**
 * Validate proposal before entry
 */
async function validateProposal(
  env: Env,
  proposal: any,
  now: Date
): Promise<{ valid: boolean; reason?: string }> {
  // Check proposal age
  const proposalAge = now.getTime() - new Date(proposal.created_at).getTime();
  if (proposalAge > MAX_PROPOSAL_AGE_MS) {
    return { valid: false, reason: 'Proposal too old' };
  }
  
  // Check proposal status
  if (proposal.status !== 'READY') {
    return { valid: false, reason: `Proposal status is ${proposal.status}` };
  }
  
  // Check spread width
  // For credit spreads: short_strike > long_strike (e.g., BULL_PUT_CREDIT: 195 > 190)
  // For debit spreads: short_strike may be < long_strike (e.g., BEAR_PUT_DEBIT: 602 < 607)
  // Always compute width as absolute difference
  const computedWidth = Math.abs(proposal.short_strike - proposal.long_strike);
  if (computedWidth !== proposal.width) {
    console.log('[entry][validation][width_mismatch]', JSON.stringify({
      proposal_id: proposal.id,
      strategy: proposal.strategy,
      short_strike: proposal.short_strike,
      long_strike: proposal.long_strike,
      proposal_width: proposal.width,
      computed_width: computedWidth,
    }));
    return { valid: false, reason: `Invalid spread width: computed ${computedWidth}, expected ${proposal.width}` };
  }
  
  if (proposal.width !== 5) {
    return { valid: false, reason: 'Width must be 5' };
  }
  
  return { valid: true };
}

/**
 * Price drift check: re-fetch quotes, re-validate credit & delta
 * 
 * Before placing an order, we must:
 * 1. Re-fetch quotes for both legs
 * 2. Recompute credit
 * 3. Verify credit >= minCredit
 * 4. Verify delta still in target range
 * 
 * If any check fails, reject the order.
 */
async function checkPriceDrift(
  broker: TradierClient,
  proposal: any,
  minCredit: number,
  minDelta: number,
  maxDelta: number
): Promise<{ 
  valid: boolean; 
  reason?: string; 
  shortPut?: any; 
  longPut?: any;
  shortCall?: any;
  longCall?: any;
  credit?: number;
  delta?: number;
}> {
  // Re-fetch option chain
  const optionChain = await broker.getOptionChain(proposal.symbol, proposal.expiration);
  
  // Determine option type based on strategy
  const optionType = (proposal.strategy === 'BEAR_CALL_CREDIT' || proposal.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
  
  const shortOption = optionChain.find(
    opt => opt.strike === proposal.short_strike && opt.type === optionType
  );
  const longOption = optionChain.find(
    opt => opt.strike === proposal.long_strike && opt.type === optionType
  );
  
  if (!shortOption || !longOption) {
    return { valid: false, reason: 'Cannot find option legs in chain' };
  }
  
  // Recompute credit/debit (same formula for both puts and calls: short bid - long ask)
  // For credit spreads: positive value (credit received)
  // For debit spreads: negative value (debit paid)
  if (!shortOption.bid || !longOption.ask || shortOption.bid <= 0 || longOption.ask <= 0) {
    return { valid: false, reason: 'Missing or invalid quotes' };
  }
  
  const newCredit = shortOption.bid - longOption.ask;
  const isDebitSpread = proposal.strategy === 'BULL_CALL_DEBIT' || proposal.strategy === 'BEAR_PUT_DEBIT';
  
  // Check credit/debit requirements based on spread type
  if (isDebitSpread) {
    // For debit spreads: check debit (absolute value) is within range (0.80 to 2.50)
    const debit = Math.abs(newCredit);
    const minDebit = 0.80;
    const maxDebit = 2.50;
    
    if (debit < minDebit || debit > maxDebit) {
      return { 
        valid: false, 
        reason: `Live debit ${debit.toFixed(2)} outside range [${minDebit}, ${maxDebit}]`,
        credit: newCredit,
      };
    }
  } else {
    // For credit spreads: check credit meets minimum requirement
    if (newCredit < minCredit) {
      return { 
        valid: false, 
        reason: `Live credit ${newCredit.toFixed(2)} below minimum ${minCredit.toFixed(2)}`,
        credit: newCredit,
      };
    }
  }
  
  // Check delta still in range
  // For debit spreads: check LONG leg delta (0.40-0.55 absolute)
  // For credit spreads: check SHORT leg delta (from config, typically -0.32 to -0.18 for puts)
  if (isDebitSpread) {
    // For debit spreads, check the long leg delta
    if (!longOption.delta) {
      return { valid: false, reason: 'Long leg delta missing for debit spread' };
    }
    const deltaLong = Math.abs(longOption.delta);
    const minDebitDelta = 0.40;
    const maxDebitDelta = 0.55;
    if (deltaLong < minDebitDelta || deltaLong > maxDebitDelta) {
      return { 
        valid: false, 
        reason: `Long leg delta ${deltaLong.toFixed(3)} outside range [${minDebitDelta}, ${maxDebitDelta}] for debit spread`,
        delta: longOption.delta,
      };
    }
  } else {
    // For credit spreads, check the short leg delta
    if (!shortOption.delta) {
      return { valid: false, reason: 'Short leg delta missing' };
    }
    // For calls, delta is positive; for puts, delta is negative
    // The minDelta/maxDelta from config are already set correctly for the strategy
    if (shortOption.delta < minDelta || shortOption.delta > maxDelta) {
      return { 
        valid: false, 
        reason: `Delta ${shortOption.delta.toFixed(3)} outside range [${minDelta}, ${maxDelta}]`,
        delta: shortOption.delta,
      };
    }
  }
  
  // Return the appropriate delta based on spread type
  const delta = isDebitSpread ? (longOption.delta ?? undefined) : (shortOption.delta ?? undefined);
  
  return { 
    valid: true, 
    shortPut: optionType === 'put' ? shortOption : undefined,
    longPut: optionType === 'put' ? longOption : undefined,
    shortCall: optionType === 'call' ? shortOption : undefined,
    longCall: optionType === 'call' ? longOption : undefined,
    credit: newCredit,
    delta: delta,
  };
}

/**
 * Compute entry limit price
 * 
 * Per execution.md:
 * For credit spreads:
 *   limit_price = mid_price - entry_slippage
 *   mid_price ≈ (bid_short - ask_long)
 * 
 * For debit spreads:
 *   limit_price = mid_price + entry_slippage
 *   mid_price ≈ (ask_long - bid_short)
 */
function computeLimitPrice(bidShort: number, askLong: number, isDebitSpread: boolean = false): number {
  let midPrice: number;
  let limitPrice: number;
  
  if (isDebitSpread) {
    // For debit spread, mid is approximately ask_long - bid_short (debit paid)
    midPrice = askLong - bidShort;
    // Add slippage to pay more than mid (increases fill probability)
    // For debit spreads, we need to be willing to pay MORE than mid to get a fill
    limitPrice = midPrice + ENTRY_SLIPPAGE;
  } else {
    // For credit spread, mid is approximately bid_short - ask_long (credit received)
    midPrice = bidShort - askLong;
    // Subtract slippage to get a better fill (receive more)
    limitPrice = midPrice - ENTRY_SLIPPAGE;
  }
  
  return Math.max(0.60, Math.min(3.00, limitPrice));
}

