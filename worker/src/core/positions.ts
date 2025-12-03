/**
 * Position Utility Module
 * 
 * Centralizes "how many contracts can we close?" logic.
 * Works purely on PortfolioPositionRow objects (no DB access).
 */

import type { PortfolioPositionRow, TradeRow } from '../types';

export interface SpreadPositionSnapshot {
  shortQty: number;   // absolute quantity of the short leg
  longQty: number;    // absolute quantity of the long leg
  shortCostBasis?: number | null;  // per contract, if available
  longCostBasis?: number | null;
  shortBid?: number | null;  // current bid price, if available
  shortAsk?: number | null;  // current ask price, if available
  longBid?: number | null;   // current bid price, if available
  longAsk?: number | null;   // current ask price, if available
}

/**
 * Given trade + its leg positions, compute a normalized snapshot.
 * 
 * Behavior:
 * - If a leg is null: its qty is 0, cost basis is null
 * - Quantity is always absolute value of PortfolioPositionRow.quantity
 * - Cost basis is taken from cost_basis_per_contract
 * - No logging (pure deterministic helper)
 */
export function computeSpreadPositionSnapshot(
  trade: TradeRow,
  shortLeg: PortfolioPositionRow | null,
  longLeg: PortfolioPositionRow | null
): SpreadPositionSnapshot {
  return {
    shortQty: shortLeg ? shortLeg.quantity : 0,
    longQty: longLeg ? longLeg.quantity : 0,
    shortCostBasis: shortLeg ? shortLeg.cost_basis_per_contract : null,
    longCostBasis: longLeg ? longLeg.cost_basis_per_contract : null,
    shortBid: shortLeg ? shortLeg.bid : null,
    shortAsk: shortLeg ? shortLeg.ask : null,
    longBid: longLeg ? longLeg.bid : null,
    longAsk: longLeg ? longLeg.ask : null,
  };
}

