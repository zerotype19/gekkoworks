/**
 * Strategy Classification
 * 
 * Provides utilities for classifying spreads and computing risk envelopes.
 */

export type SpreadStrategy =
  | 'BULL_PUT_CREDIT'
  | 'BEAR_CALL_CREDIT'
  | 'BULL_CALL_DEBIT'
  | 'BEAR_PUT_DEBIT';

export type OptionType = 'call' | 'put';

/**
 * Classify a spread from strikes and option type
 * 
 * Rules:
 * - optionType === 'put':
 *   - shortStrike > longStrike → BULL_PUT_CREDIT
 *   - shortStrike < longStrike → BEAR_PUT_DEBIT
 * - optionType === 'call':
 *   - shortStrike < longStrike → BEAR_CALL_CREDIT
 *   - shortStrike > longStrike → BULL_CALL_DEBIT
 */
export function classifySpreadFromStrikesAndType(
  optionType: 'call' | 'put',
  shortStrike: number,
  longStrike: number
): SpreadStrategy {
  if (optionType === 'put') {
    if (shortStrike > longStrike) {
      return 'BULL_PUT_CREDIT';
    } else {
      return 'BEAR_PUT_DEBIT';
    }
  } else {
    // optionType === 'call'
    if (shortStrike < longStrike) {
      return 'BEAR_CALL_CREDIT';
    } else {
      return 'BULL_CALL_DEBIT';
    }
  }
}

