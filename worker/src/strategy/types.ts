/**
 * Strategy Type Definitions
 * 
 * Defines all available trading strategies in the system.
 */

export enum StrategyId {
  BULL_PUT_CREDIT = 'BULL_PUT_CREDIT',
  BEAR_CALL_CREDIT = 'BEAR_CALL_CREDIT',
  BULL_CALL_DEBIT = 'BULL_CALL_DEBIT',
  BEAR_PUT_DEBIT = 'BEAR_PUT_DEBIT',
  IRON_CONDOR = 'IRON_CONDOR',
}

// Type alias for strategy IDs - uses enum values, not keys
// This ensures the type matches actual strategy ID values even if enum keys/values diverge
export type StrategyIdType = StrategyId;

