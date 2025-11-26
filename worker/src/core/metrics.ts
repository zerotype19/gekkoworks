/**
 * SAS v1 Core Metrics Calculations
 * 
 * Pure function library for computing market metrics:
 * - DTE calculation
 * - IVR calculation
 * - RV/IV ratio
 * - Vertical skew
 * - Term structure skew
 * - POP, EV, etc.
 * 
 * This module must be a pure function library (no DB, no network).
 * Per system-interfaces.md and scoring-model.md.
 */

import { computeDTE } from './time';

// Re-export DTE from time.ts as it's part of metrics interface
export { computeDTE };

/**
 * Compute IV Rank (IVR) on a 52-week range
 * 
 * Per strategy-engine.md and scoring-model.md:
 * IVR = (IV_now - IV_min_52wk) / (IV_max_52wk - IV_min_52wk)
 * 
 * Returns a normalized value in [0, 1] range:
 * - 0 = IV_now at 52-week minimum
 * - 1 = IV_now at 52-week maximum
 * 
 * Invalid cases (returns NaN):
 * - Denominator = 0 (degenerate range)
 * - IV_now outside 52-week range (bad feed, stale cache) - treated as invalid
 */
export function computeIVR(params: {
  iv_now: number;
  iv_min_52w: number;
  iv_max_52w: number;
}): number {
  const { iv_now, iv_min_52w, iv_max_52w } = params;
  
  const denominator = iv_max_52w - iv_min_52w;
  
  if (denominator === 0) {
    // Per scoring-model.md: "If denominator = 0 → reject candidate"
    return NaN;
  }
  
  const ivr = (iv_now - iv_min_52w) / denominator;
  
  // Treat out-of-range IV as invalid (bad feed, stale cache, etc.)
  // This enforces the "normalized 0-1 rank" contract
  if (ivr < 0 || ivr > 1) {
    return NaN;
  }
  
  return ivr;
}

/**
 * Compute Vertical Skew
 * 
 * Per revised spec (absolute-ratio version):
 * vertical_skew = |(IV_long / IV_short) - 1|
 * 
 * This measures the absolute deviation from flat IV between legs:
 * - 0.00 = flat (IV_long = IV_short)
 * - 0.10 = 10% difference (e.g., IV_long = 0.275, IV_short = 0.25)
 * - Always >= 0 (no sign, measures magnitude of distortion)
 * 
 * Invalid if:
 * - NaN (iv_short = 0, cannot divide)
 * - > 0.50 (too extreme → tail risk) - validated upstream
 * 
 * NOTE: This is an absolute measure and does not distinguish "inverted" vs "normal" skew.
 * The original formula (IV_short - IV_long) / IV_short would be negative for inverted skew,
 * but this version uses absolute value to measure distortion magnitude.
 */
export function computeVerticalSkew(params: {
  iv_short: number;
  iv_long: number;
}): number {
  const { iv_short, iv_long } = params;
  
  if (iv_short === 0) {
    return NaN; // Cannot divide by zero
  }

  // Measure skew as distance from flat using the IV ratio between legs:
  //   ratio = IV_long / IV_short
  //   vertical_skew = |ratio - 1|
  //
  // Examples:
  // - IV_short = 0.25, IV_long = 0.25 → ratio = 1.0  → skew = 0.00 (flat)
  // - IV_short = 0.25, IV_long = 0.275 → ratio ≈ 1.10 → skew ≈ 0.10 (10% steeper)
  const ratio = iv_long / iv_short;
  const vertical_skew = Math.abs(ratio - 1);
  
  return vertical_skew;
}

/**
 * Check if vertical skew is within valid range
 * 
 * @param skew - Vertical skew value (from computeVerticalSkew)
 * @param max - Maximum allowed skew (default 0.50)
 * @returns true if skew is valid (finite and <= max)
 */
export function isVerticalSkewValid(skew: number, max: number = 0.50): boolean {
  return Number.isFinite(skew) && skew >= 0 && skew <= max;
}

/**
 * Compute Term Structure (Horizontal Skew)
 * 
 * Per strategy-engine.md and scoring-model.md:
 * term_structure = (front_IV - back_IV) / back_IV
 * 
 * Where:
 * - front_IV = IV of selected expiration
 * - back_IV = IV of next monthly expiration (DTE > selected)
 * 
 * If term_structure < -0.05 → reject
 */
export function computeTermStructure(params: {
  front_iv: number;
  back_iv: number;
}): number {
  const { front_iv, back_iv } = params;
  
  if (back_iv === 0) {
    return NaN; // Cannot divide by zero
  }
  
  const term_structure = (front_iv - back_iv) / back_iv;
  
  return term_structure;
}

/**
 * Compute Probability of Profit (POP)
 * 
 * Per strategy-engine.md and scoring-model.md:
 * POP = 1 - |delta_short|
 * 
 * Works for both puts and calls:
 * - Puts: delta_short is negative (e.g., -0.30) → |delta_short| = 0.30 → POP = 0.70
 * - Calls: delta_short is positive (e.g., 0.30) → |delta_short| = 0.30 → POP = 0.70
 * 
 * Returns value clamped to [0, 1] range.
 */
export function computePOP(delta_short: number): number {
  const pop = 1 - Math.abs(delta_short);
  
  // Clamp to [0, 1] range
  return Math.max(0, Math.min(1, pop));
}

/**
 * Compute Expected Value (EV)
 * 
 * Per strategy-engine.md and scoring-model.md:
 * POP = 1 - |delta_short|
 * max_profit = credit
 * max_loss = width - credit
 * EV = POP * max_profit - (1 - POP) * max_loss
 * 
 * NOTE: EV is NOT used as a hard filter. It is computed for informational purposes
 * and may be used in scoring, but candidates are NOT rejected based on EV ≤ 0.
 * This is because the simplified EV formula doesn't accurately represent the actual
 * probability distribution of credit spread outcomes (most losers are partial, not full max loss).
 */
export function computeEV(params: {
  pop: number;
  credit: number;
  width: number;
}): number {
  const { pop, credit, width } = params;
  
  const max_profit = credit;
  const max_loss = width - credit;
  
  const ev = pop * max_profit - (1 - pop) * max_loss;
  
  return ev;
}

/**
 * Compute IV over RV ratio
 * 
 * Per strategy-engine.md:
 * IV_30d / RV_30d >= 1.20 required
 * 
 * This function computes the ratio for validation.
 * 
 * NOTE: Parameter order is (rv_30d, iv_30d) but calculation is iv_30d / rv_30d.
 * This matches the natural reading "IV over RV" but can be confusing at call sites.
 * Consider using named parameters: computeIVOverRVRatio({ rv_30d, iv_30d })
 */
export function computeRVIVRatio(rv_30d: number, iv_30d: number): number {
  if (rv_30d === 0) {
    return NaN; // Cannot divide by zero
  }
  
  return iv_30d / rv_30d;
}

/**
 * Check if IV over RV ratio meets requirement
 * 
 * Per strategy-engine.md:
 * IV_30d / RV_30d >= 1.20 required
 * 
 * NOTE: Parameter order is (rv_30d, iv_30d) but calculation is iv_30d / rv_30d.
 */
export function isRVIVRatioValid(rv_30d: number, iv_30d: number): boolean {
  const ratio = computeRVIVRatio(rv_30d, iv_30d);
  return !isNaN(ratio) && ratio >= 1.20;
}

