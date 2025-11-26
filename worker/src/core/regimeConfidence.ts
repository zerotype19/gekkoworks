/**
 * Regime Confidence Utilities
 * 
 * Shared utilities for regime confidence calculations.
 * Used by both entry engine and HTTP debug endpoints.
 */

const MIN_REGIME_CONFIDENCE = 0.004; // 0.4% threshold

/**
 * Check if regime confidence is sufficient for trading
 * 
 * regime_confidence = |price - SMA_20| / price
 * 
 * High confidence (>= 0.004): Clear directional bias, trading allowed
 * Low confidence (< 0.004): Uncertain/chop, trading should be paused
 */
export function isRegimeConfidenceSufficient(regimeConfidence: number | null): boolean {
  if (regimeConfidence === null) {
    // If SMA unavailable, allow trading (fallback behavior)
    return true;
  }
  return regimeConfidence >= MIN_REGIME_CONFIDENCE;
}

export const MIN_REGIME_CONFIDENCE_THRESHOLD = MIN_REGIME_CONFIDENCE;

