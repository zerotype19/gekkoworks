/**
 * Get open positions for a trade from portfolio_positions table
 * 
 * This is the canonical source of truth for what positions we actually hold.
 * Returns positions that match the trade's symbol, expiration, and strikes.
 */

import type { Env } from '../env';
import type { TradeRow, PortfolioPositionRow } from '../types';
import { getSpreadLegPositions } from '../db/queries';

/**
 * Get open positions for a trade
 * 
 * Returns positions from portfolio_positions that match the trade's:
 * - symbol
 * - expiration
 * - option_type (call/put, derived from strategy)
 * - strikes (short_strike and long_strike)
 * 
 * Positions are returned with non-zero quantities.
 */
export async function getOpenPositionsForTrade(
  env: Env,
  trade: TradeRow
): Promise<PortfolioPositionRow[]> {
  if (!trade.strategy) {
    throw new Error(`Trade ${trade.id} missing strategy - cannot determine option type`);
  }
  
  const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') 
    ? 'call' 
    : 'put';
  
  // Get positions for both legs
  const { shortLeg, longLeg } = await getSpreadLegPositions(
    env,
    trade.symbol,
    trade.expiration,
    optionType,
    trade.short_strike,
    trade.long_strike
  );
  
  const positions: PortfolioPositionRow[] = [];
  
  // Add short leg if it exists and has non-zero quantity
  if (shortLeg && shortLeg.quantity > 0) {
    positions.push(shortLeg);
  }
  
  // Add long leg if it exists and has non-zero quantity
  if (longLeg && longLeg.quantity > 0) {
    positions.push(longLeg);
  }
  
  return positions;
}

