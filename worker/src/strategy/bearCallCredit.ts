/**
 * Bear Call Credit Spread Strategy
 * 
 * Builds candidates for bear call credit spreads:
 * - Sell CALL at lower strike (short_call) - closer to money, higher delta
 * - Buy CALL at higher strike (long_call) - further OTM, lower delta
 * - Width = 5 points (matches lifecycle/monitoring invariants)
 * - Delta range: per-strategy configurable via config.targetDeltaRange (default 0.20–0.35, positive for calls)
 * - Strikes must be ABOVE current underlying price (OTM)
 * 
 * NOTE: This builder is for BEAR_CALL_CREDIT only. Uses shared VerticalCandidate type
 * which supports both BULL_PUT_CREDIT and BEAR_CALL_CREDIT strategies.
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
 * Build bear call credit spread candidates from option chain
 */
export function buildBearCallCreditCandidates(
  config: StrategyConfig,
  chain: OptionQuote[],
  underlying: UnderlyingQuote,
  dte: number
): VerticalCandidate[] {
  const candidates: VerticalCandidate[] = [];
  
  // Filter to CALL options only
  const calls = chain.filter(opt => opt.type === 'call');
  
  // Performance optimization: build strike map for O(1) lookups instead of O(n) find
  const callsByStrike = new Map<number, OptionQuote>();
  for (const call of calls) {
    callsByStrike.set(call.strike, call);
  }
  
  // Build candidates with delta in range (positive for calls)
  for (const shortCall of calls) {
    // Check delta range (delta is positive for calls)
    // Range is configurable per-strategy via config.targetDeltaRange
    if (!shortCall.delta || shortCall.delta < config.targetDeltaRange.min || shortCall.delta > config.targetDeltaRange.max) {
      continue;
    }
    
    // Ensure short strike is ABOVE current underlying (OTM for bear call)
    if (shortCall.strike <= underlying.last) {
      continue; // Short call must be OTM (above current price)
    }
    
    // Find long call (short_strike + width)
    // Uses strike map for O(1) lookup instead of O(n) find
    const longStrike = shortCall.strike + WIDTH;
    const longCall = callsByStrike.get(longStrike);
    
    if (!longCall) {
      continue; // No matching long strike
    }
    
    // Compute credit (for calls: short bid - long ask)
    if (!shortCall.bid || !longCall.ask || shortCall.bid <= 0 || longCall.ask <= 0) {
      continue; // Missing or invalid quotes
    }
    
    const credit = shortCall.bid - longCall.ask;
    if (credit <= 0) {
      continue; // Invalid credit
    }
    
    candidates.push({
      symbol: underlying.symbol,
      // NOTE: OptionQuote uses expiration_date, but VerticalCandidate uses expiration
      // This field is normalized to 'YYYY-MM-DD' format and flows through to TradeRow.expiration
      expiration: shortCall.expiration_date,
      short_strike: shortCall.strike,
      long_strike: longCall.strike,
      width: WIDTH,
      credit,
      strategy: 'BEAR_CALL_CREDIT',
      short_call: shortCall,
      long_call: longCall,
      dte,
    });
  }
  
  return candidates;
}

