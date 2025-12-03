/**
 * Strategy Invariants Checker
 * 
 * Centralized validation of strategy + strike/leg relationships.
 * Ensures consistency across the entire codebase.
 * 
 * Key invariants:
 * - BULL_PUT_CREDIT: PUTs, short_strike > long_strike (e.g., 640/635)
 * - BEAR_CALL_CREDIT: CALLs, short_strike < long_strike (e.g., 640/645)
 * - BULL_CALL_DEBIT: CALLs, long_strike < short_strike (e.g., 635/640)
 * - BEAR_PUT_DEBIT: PUTs, long_strike > short_strike (e.g., 645/640)
 */

import type { TradeRow } from '../types';

export interface StrategyInvariantResult {
  ok: boolean;
  violations: string[];
}

/**
 * Check strategy invariants for a trade
 * 
 * Verifies:
 * - Width matches strike difference
 * - Strategy matches option type expectations
 * - Strike relationships match strategy definition
 */
export function checkStrategyInvariants(trade: TradeRow): StrategyInvariantResult {
  const violations: string[] = [];

  // Common invariants
  const calculatedWidth = Math.abs(trade.short_strike - trade.long_strike);
  if (trade.width !== calculatedWidth) {
    violations.push(`width mismatch: stored=${trade.width}, calculated=${calculatedWidth}`);
  }

  if (trade.width <= 0) {
    violations.push(`width must be > 0, got ${trade.width}`);
  }

  if (!trade.strategy) {
    violations.push('strategy is missing');
    return { ok: false, violations };
  }

  // Strategy-specific invariants
  switch (trade.strategy) {
    case 'BULL_PUT_CREDIT':
      // PUTs, short_strike > long_strike (e.g., short 640, long 635)
      // This is intentional: we sell the higher strike PUT, buy the lower strike PUT
      if (trade.short_strike <= trade.long_strike) {
        violations.push(`BULL_PUT_CREDIT: short_strike (${trade.short_strike}) must be > long_strike (${trade.long_strike})`);
      }
      break;

    case 'BEAR_CALL_CREDIT':
      // CALLs, short_strike < long_strike (e.g., short 640, long 645)
      // This is intentional: we sell the lower strike CALL, buy the higher strike CALL
      if (trade.short_strike >= trade.long_strike) {
        violations.push(`BEAR_CALL_CREDIT: short_strike (${trade.short_strike}) must be < long_strike (${trade.long_strike})`);
      }
      break;

    case 'BULL_CALL_DEBIT':
      // CALLs, long_strike < short_strike (e.g., long 635, short 640)
      // This is intentional: we buy the lower strike CALL, sell the higher strike CALL
      if (trade.long_strike >= trade.short_strike) {
        violations.push(`BULL_CALL_DEBIT: long_strike (${trade.long_strike}) must be < short_strike (${trade.short_strike})`);
      }
      break;

    case 'BEAR_PUT_DEBIT':
      // PUTs, long_strike > short_strike (e.g., long 645, short 640)
      // This is intentional: we buy the higher strike PUT, sell the lower strike PUT
      if (trade.long_strike <= trade.short_strike) {
        violations.push(`BEAR_PUT_DEBIT: long_strike (${trade.long_strike}) must be > short_strike (${trade.short_strike})`);
      }
      break;

    default:
      violations.push(`unknown strategy: ${trade.strategy}`);
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

/**
 * Check strategy invariants against actual broker legs
 * 
 * Verifies that the trade's strategy matches the actual order legs:
 * - Option type (PUT vs CALL) matches strategy
 * - Strike relationships match strategy
 * - Leg directions (SELL_TO_OPEN vs BUY_TO_OPEN) match strategy
 */
export function checkStrategyAgainstLegs(
  trade: TradeRow,
  legs: Array<{
    option_symbol: string;
    side: 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';
    strike: number;
    option_type: 'put' | 'call';
  }>
): StrategyInvariantResult {
  const violations: string[] = [];

  // First check basic invariants
  const basicCheck = checkStrategyInvariants(trade);
  if (!basicCheck.ok) {
    violations.push(...basicCheck.violations);
  }

  if (legs.length !== 2) {
    violations.push(`expected 2 legs, got ${legs.length}`);
    return { ok: false, violations };
  }

  // Determine expected option type from strategy
  const expectedOptionType: 'put' | 'call' =
    trade.strategy === 'BULL_PUT_CREDIT' || trade.strategy === 'BEAR_PUT_DEBIT' ? 'put' : 'call';

  // Verify option types match strategy
  for (const leg of legs) {
    if (leg.option_type !== expectedOptionType) {
      violations.push(
        `${trade.strategy} expects ${expectedOptionType}, but leg has ${leg.option_type}`
      );
    }
  }

  // Find short and long legs based on side
  const shortLeg = legs.find(leg => leg.side.includes('sell'));
  const longLeg = legs.find(leg => leg.side.includes('buy'));

  if (!shortLeg || !longLeg) {
    violations.push('could not identify short and long legs from side');
    return { ok: false, violations };
  }

  // Verify strikes match trade
  const shortStrikeMatches = shortLeg.strike === trade.short_strike;
  const longStrikeMatches = longLeg.strike === trade.long_strike;

  if (!shortStrikeMatches) {
    violations.push(
      `short leg strike (${shortLeg.strike}) does not match trade.short_strike (${trade.short_strike})`
    );
  }

  if (!longStrikeMatches) {
    violations.push(
      `long leg strike (${longLeg.strike}) does not match trade.long_strike (${trade.long_strike})`
    );
  }

  // Verify strike relationships match strategy
  switch (trade.strategy) {
    case 'BULL_PUT_CREDIT':
      // Short leg should be higher strike, long leg should be lower strike
      if (shortLeg.strike <= longLeg.strike) {
        violations.push(
          `BULL_PUT_CREDIT: short leg strike (${shortLeg.strike}) must be > long leg strike (${longLeg.strike})`
        );
      }
      // Verify directions: SELL_TO_OPEN short, BUY_TO_OPEN long
      if (!shortLeg.side.includes('sell') || !longLeg.side.includes('buy')) {
        violations.push(
          `BULL_PUT_CREDIT: short leg should be SELL_TO_OPEN, long leg should be BUY_TO_OPEN`
        );
      }
      break;

    case 'BEAR_CALL_CREDIT':
      // Short leg should be lower strike, long leg should be higher strike
      if (shortLeg.strike >= longLeg.strike) {
        violations.push(
          `BEAR_CALL_CREDIT: short leg strike (${shortLeg.strike}) must be < long leg strike (${longLeg.strike})`
        );
      }
      // Verify directions: SELL_TO_OPEN short, BUY_TO_OPEN long
      if (!shortLeg.side.includes('sell') || !longLeg.side.includes('buy')) {
        violations.push(
          `BEAR_CALL_CREDIT: short leg should be SELL_TO_OPEN, long leg should be BUY_TO_OPEN`
        );
      }
      break;

    case 'BULL_CALL_DEBIT':
      // Long leg should be lower strike, short leg should be higher strike
      if (longLeg.strike >= shortLeg.strike) {
        violations.push(
          `BULL_CALL_DEBIT: long leg strike (${longLeg.strike}) must be < short leg strike (${shortLeg.strike})`
        );
      }
      // Verify directions: BUY_TO_OPEN long, SELL_TO_OPEN short
      if (!longLeg.side.includes('buy') || !shortLeg.side.includes('sell')) {
        violations.push(
          `BULL_CALL_DEBIT: long leg should be BUY_TO_OPEN, short leg should be SELL_TO_OPEN`
        );
      }
      break;

    case 'BEAR_PUT_DEBIT':
      // Long leg should be higher strike, short leg should be lower strike
      if (longLeg.strike <= shortLeg.strike) {
        violations.push(
          `BEAR_PUT_DEBIT: long leg strike (${longLeg.strike}) must be > short leg strike (${shortLeg.strike})`
        );
      }
      // Verify directions: BUY_TO_OPEN long, SELL_TO_OPEN short
      if (!longLeg.side.includes('buy') || !shortLeg.side.includes('sell')) {
        violations.push(
          `BEAR_PUT_DEBIT: long leg should be BUY_TO_OPEN, short leg should be SELL_TO_OPEN`
        );
      }
      break;
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

