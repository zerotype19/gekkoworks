/**
 * Bull Put Credit Spread Strategy
 * 
 * Builds candidates for bull put credit spreads:
 * - Sell PUT at higher strike (short_put) - closer to ATM
 * - Buy PUT at lower strike (long_put) - further OTM
 * - Width = 5 points (matches lifecycle/monitoring invariants)
 * - Delta range: per-strategy configurable via config.targetDeltaRange
 *   (default -0.32 to -0.18, negative for puts - uses raw negative values, not abs)
 * - Strikes must be BELOW current underlying price (OTM for bull put)
 * 
 * NOTE: Strike pattern is long_strike = short_strike - width (long lower, short higher).
 * This matches validateSpreadInvariants in lifecycle.ts and checkStructuralIntegrity in monitoring.ts.
 * 
 * NOTE: Credit filtering (min credit, R:R) is handled downstream in passesHardFiltersWithReason.
 */

import type { OptionQuote, UnderlyingQuote } from '../types';
import type { StrategyConfig } from './config';

export interface VerticalCandidate {
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  credit: number;
  strategy: 'BULL_PUT_CREDIT' | 'BEAR_CALL_CREDIT';
  short_put?: OptionQuote;
  long_put?: OptionQuote;
  short_call?: OptionQuote;
  long_call?: OptionQuote;
  dte: number;
}

const WIDTH = 5;

/**
 * Build bull put credit spread candidates from option chain
 */
export function buildBullPutCreditCandidates(
  config: StrategyConfig,
  chain: OptionQuote[],
  underlying: UnderlyingQuote,
  dte: number
): VerticalCandidate[] {
  const candidates: VerticalCandidate[] = [];
  
  // Filter to PUT options only
  const puts = chain.filter(opt => opt.type === 'put');
  
  // Performance optimization: build strike map for O(1) lookups instead of O(n) find
  const putsByStrike = new Map<number, OptionQuote>();
  for (const put of puts) {
    putsByStrike.set(put.strike, put);
  }
  
  // Build candidates with delta in range (negative for puts)
  // NOTE: Delta range is configurable per-strategy via config.targetDeltaRange
  // For puts, delta is negative, so config should use negative values (e.g., min=-0.32, max=-0.18)
  // This differs from bearPutDebit which uses abs(delta) - be consistent with your config setup
  for (const shortPut of puts) {
    // Check delta range (delta is negative for puts, so minDelta < maxDelta)
    // Range is configurable per-strategy via config.targetDeltaRange
    if (!shortPut.delta || shortPut.delta < config.targetDeltaRange.min || shortPut.delta > config.targetDeltaRange.max) {
      continue;
    }
    
    // Ensure short strike is BELOW current underlying (OTM for bull put)
    // This mirrors the OTM check in bearCallCredit (short call must be above underlying)
    if (shortPut.strike >= underlying.last) {
      continue; // Short put must be OTM (below current price)
    }
    
    // Find long put (short_strike - width)
    // Uses strike map for O(1) lookup instead of O(n) find
    const longStrike = shortPut.strike - WIDTH;
    const longPut = putsByStrike.get(longStrike);
    
    if (!longPut) {
      continue; // No matching long strike
    }
    
    // Compute credit
    if (!shortPut.bid || !longPut.ask || shortPut.bid <= 0 || longPut.ask <= 0) {
      continue; // Missing or invalid quotes
    }
    
    const credit = shortPut.bid - longPut.ask;
    if (credit <= 0) {
      continue; // Invalid credit
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
      // NOTE: OptionQuote uses expiration_date, but VerticalCandidate uses expiration
      // This field is normalized to 'YYYY-MM-DD' format and flows through to TradeRow.expiration
      expiration: shortPut.expiration_date,
      short_strike: shortPut.strike,
      long_strike: longPut.strike,
      width: WIDTH,
      credit,
      strategy: 'BULL_PUT_CREDIT',
      // NOTE: short_put and long_put are always set for BULL_PUT_CREDIT candidates
      // They're marked optional in the interface to support shared types with other strategies
      short_put: shortPut,
      long_put: longPut,
      dte,
    });
  }
  
  return candidates;
}

