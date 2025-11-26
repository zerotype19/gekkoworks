/**
 * Bull Call Debit Spread Strategy
 * 
 * Builds candidates for bull call debit spreads:
 * - Buy CALL at lower strike (long_call) - closer to ATM, per-strategy configurable delta range
 *   (default 0.40-0.55, positive for calls)
 * - Sell CALL at higher strike (short_call) - 5 points above
 * - Width = 5 points (matches lifecycle/monitoring invariants)
 * - Direction: bullish
 * - Debit: ask_long - bid_short
 * - Max loss = debit
 * - Max profit = width - debit
 * 
 * NOTE: Strike pattern is long_strike = short_strike - width (long lower, short higher).
 * This matches validateSpreadInvariants in lifecycle.ts and checkStructuralIntegrity in monitoring.ts.
 */

import type { OptionQuote, UnderlyingQuote } from '../types';
import type { StrategyConfig } from './config';

export interface DebitCandidate {
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  debit: number;
  strategy: 'BULL_CALL_DEBIT';
  short_call?: OptionQuote;
  long_call?: OptionQuote;
  dte: number;
}

const WIDTH = 5;
const MIN_DEBIT = 0.80;
const MAX_DEBIT = 2.50;
const MIN_REWARD_TO_RISK = 1.0;

/**
 * Build bull call debit spread candidates from option chain
 */
export function buildBullCallDebitCandidates(
  config: StrategyConfig,
  chain: OptionQuote[],
  underlying: UnderlyingQuote,
  dte: number
): DebitCandidate[] {
  const candidates: DebitCandidate[] = [];
  
  // Filter to CALL options only
  const calls = chain.filter(opt => opt.type === 'call');
  
  // Performance optimization: build strike map for O(1) lookups instead of O(n) find
  const callsByStrike = new Map<number, OptionQuote>();
  for (const call of calls) {
    callsByStrike.set(call.strike, call);
  }
  
  // Build candidates with long call delta in range
  // Delta range is configurable per-strategy via config.targetDeltaRange (default 0.40-0.55)
  for (const longCall of calls) {
    // Check delta range for long leg (delta is positive for calls)
    // Range is configurable per-strategy via config.targetDeltaRange
    if (!longCall.delta || longCall.delta < config.targetDeltaRange.min || longCall.delta > config.targetDeltaRange.max) {
      continue;
    }
    
    // Find short call (long_strike + width)
    // Uses strike map for O(1) lookup instead of O(n) find
    const shortStrike = longCall.strike + WIDTH;
    const shortCall = callsByStrike.get(shortStrike);
    
    if (!shortCall) {
      continue; // No matching short strike
    }
    
    // Compute debit (for debit spreads: ask_long - bid_short)
    if (!longCall.ask || !shortCall.bid || longCall.ask <= 0 || shortCall.bid <= 0) {
      continue; // Missing or invalid quotes
    }
    
    const debit = longCall.ask - shortCall.bid;
    
    // Validate debit range
    if (debit < MIN_DEBIT || debit > MAX_DEBIT) {
      continue;
    }
    
    // Validate reward-to-risk ratio
    const maxProfit = WIDTH - debit;
    const maxLoss = debit;
    const rewardToRisk = maxProfit / maxLoss;
    
    if (rewardToRisk < MIN_REWARD_TO_RISK) {
      continue; // R:R too low
    }
    
    // Validate liquidity
    // NOTE: Entry uses hard-coded 0.15 threshold (stricter than monitoring's default 0.30)
    // This is intentional - stricter on entry than on exit
    // If you want consistency, consider moving this to config or reusing monitoring threshold
    const longSpread = longCall.ask - longCall.bid;
    const shortSpread = shortCall.ask - shortCall.bid;
    
    if (longSpread > 0.15 || shortSpread > 0.15) {
      continue; // Spreads too wide
    }
    
    candidates.push({
      symbol: underlying.symbol,
      // NOTE: OptionQuote uses expiration_date, but DebitCandidate uses expiration
      // This field is normalized to 'YYYY-MM-DD' format and flows through to TradeRow.expiration
      expiration: longCall.expiration_date,
      short_strike: shortCall.strike,
      long_strike: longCall.strike,
      width: WIDTH,
      debit,
      strategy: 'BULL_CALL_DEBIT',
      // NOTE: short_call and long_call are always set for BULL_CALL_DEBIT candidates
      // They're marked optional in the interface to support shared types with other strategies
      short_call: shortCall,
      long_call: longCall,
      dte,
    });
  }
  
  return candidates;
}

