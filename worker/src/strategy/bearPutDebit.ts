/**
 * Bear Put Debit Spread Strategy
 * 
 * Builds candidates for bear put debit spreads:
 * - Buy PUT at higher strike (long_put) - closer to ATM, per-strategy configurable delta range
 *   (default 0.40-0.55, negative for puts, checked as absolute value)
 * - Sell PUT at lower strike (short_put) - 5 points below
 * - Width = 5 points (matches lifecycle/monitoring invariants)
 * - Direction: bearish
 * - Debit: ask_long - bid_short
 * - Max loss = debit
 * - Max profit = width - debit
 * 
 * NOTE: Strike pattern is long_strike = short_strike + width (long higher, short lower).
 * This matches validateSpreadInvariants in lifecycle.ts and checkStructuralIntegrity in monitoring.ts.
 */

import type { OptionQuote, UnderlyingQuote } from '../types';
import type { StrategyConfig } from './config';

export interface BearDebitCandidate {
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  debit: number;
  strategy: 'BEAR_PUT_DEBIT';
  short_put?: OptionQuote;
  long_put?: OptionQuote;
  dte: number;
}

const WIDTH = 5;
const MIN_DEBIT = 0.80;
const MAX_DEBIT = 2.50;
const MIN_REWARD_TO_RISK = 1.0;

/**
 * Build bear put debit spread candidates from option chain
 */
export function buildBearPutDebitCandidates(
  config: StrategyConfig,
  chain: OptionQuote[],
  underlying: UnderlyingQuote,
  dte: number
): BearDebitCandidate[] {
  const candidates: BearDebitCandidate[] = [];
  
  // Filter to PUT options only
  const puts = chain.filter(opt => opt.type === 'put');
  
  // Performance optimization: build strike map for O(1) lookups instead of O(n) find
  const putsByStrike = new Map<number, OptionQuote>();
  for (const put of puts) {
    putsByStrike.set(put.strike, put);
  }
  
  // Build candidates with long put delta in range
  // Delta range is configurable per-strategy via config.targetDeltaRange (default 0.40-0.55)
  // For puts, delta is negative, so we check abs(delta) in range
  for (const longPut of puts) {
    // Check delta range for long leg (delta is negative for puts, so check absolute value)
    // Range is configurable per-strategy via config.targetDeltaRange
    const absDelta = longPut.delta ? Math.abs(longPut.delta) : 0;
    if (absDelta < config.targetDeltaRange.min || absDelta > config.targetDeltaRange.max) {
      continue;
    }
    
    // Find short put (long_strike - width)
    // Uses strike map for O(1) lookup instead of O(n) find
    const shortStrike = longPut.strike - WIDTH;
    const shortPut = putsByStrike.get(shortStrike);
    
    if (!shortPut) {
      continue; // No matching short strike
    }
    
    // Compute debit (for debit spreads: ask_long - bid_short)
    if (!longPut.ask || !shortPut.bid || longPut.ask <= 0 || shortPut.bid <= 0) {
      continue; // Missing or invalid quotes
    }
    
    const debit = longPut.ask - shortPut.bid;
    
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
    const longSpread = longPut.ask - longPut.bid;
    const shortSpread = shortPut.ask - shortPut.bid;
    
    if (longSpread > 0.15 || shortSpread > 0.15) {
      continue; // Spreads too wide
    }
    
    candidates.push({
      symbol: underlying.symbol,
      // NOTE: OptionQuote uses expiration_date, but BearDebitCandidate uses expiration
      // This field is normalized to 'YYYY-MM-DD' format and flows through to TradeRow.expiration
      expiration: longPut.expiration_date,
      short_strike: shortPut.strike,
      long_strike: longPut.strike,
      width: WIDTH,
      debit,
      strategy: 'BEAR_PUT_DEBIT',
      // NOTE: short_put and long_put are always set for BEAR_PUT_DEBIT candidates
      // They're marked optional in the interface to support shared types with other strategies
      short_put: shortPut,
      long_put: longPut,
      dte,
    });
  }
  
  return candidates;
}

