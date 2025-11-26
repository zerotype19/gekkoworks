/**
 * SAS v2 Scoring Model
 *
 * Implements POP‑led, IVR‑aware, credit‑ and liquidity‑sensitive scoring.
 *
 * Component weights (must sum to 1):
 * - POP component               : 0.40
 * - Credit quality (credit/width) : 0.25
 * - IVR sweet spot              : 0.20
 * - Delta suitability           : 0.08
 * - Liquidity (pct spreads)     : 0.04
 * - Vertical skew penalty       : 0.03
 *
 * Composite score threshold is configured via core/config.ts
 */

import type { CandidateMetrics, ScoringResult } from '../types';
import type { TradingMode } from './config';
import { computePOP, computeEV } from './metrics';

const WEIGHTS = {
  pop: 0.40,
  credit: 0.25,
  ivr: 0.20,
  delta: 0.08,
  liquidity: 0.04,
  skew: 0.03,
};

/**
 * Clamp a value between 0 and 1
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Score a candidate spread (v2)
 *
 * Per system-interfaces.md:
 * export function scoreCandidate(metrics: CandidateMetrics): ScoringResult;
 *
 * Returns ScoringResult with all component scores and composite_score.
 * If any component fails a hard filter, this function throws and the candidate is rejected.
 */
export function scoreCandidate(
  metrics: CandidateMetrics,
  opts?: { minCreditFraction?: number; mode?: TradingMode }
): ScoringResult {
  const { width, credit } = metrics;
  const mode = opts?.mode ?? 'DRY_RUN';

  // -----------------------
  // v2 HARD FILTERS
  // -----------------------
  // Default to 0.16 (16% of width) to match core/config.ts default
  // Callers should pass minCreditFraction from getStrategyThresholds() for consistency
  const minCreditFraction = opts?.minCreditFraction ?? 0.16;

  // POP gate (0–1 scale)
  // Normalize POP to 0-1 scale if it comes in as 0-100
  let rawPop = metrics.pop ?? computePOP(metrics.delta_short);
  if (rawPop > 1.0 && rawPop <= 100.0) {
    // Assume 0-100 scale, normalize to 0-1
    rawPop = rawPop / 100.0;
  }
  if (rawPop < 0.65) {
    console.log(
      '[scoring] HARD_REJECTION',
      JSON.stringify({
        reason: 'POP_TOO_LOW',
        symbol: metrics.symbol,
        expiration: metrics.expiration,
        short_strike: metrics.short_strike,
        long_strike: metrics.long_strike,
        pop: rawPop,
      })
    );
    throw new Error('HARD_FILTER: POP_TOO_LOW');
  }

  // IVR gate (0–1 scale)
  // Normalize IVR to 0-1 scale if it comes in as 0-100
  let ivr_value = metrics.ivr;
  if (ivr_value != null && ivr_value > 1.0 && ivr_value <= 100.0) {
    // Assume 0-100 scale, normalize to 0-1
    ivr_value = ivr_value / 100.0;
  }
  // In LIVE/DRY_RUN, enforce a basic IVR sanity range.
  // In SANDBOX_PAPER we treat IVR as neutral (weight 0) and do not hard-fail on it.
  if (mode !== 'SANDBOX_PAPER') {
    if (!Number.isFinite(ivr_value) || ivr_value < 0.15 || ivr_value > 0.70) {
      console.log(
        '[scoring] HARD_REJECTION',
        JSON.stringify({
          reason: 'IVR_OUT_OF_RANGE',
          symbol: metrics.symbol,
          expiration: metrics.expiration,
          short_strike: metrics.short_strike,
          long_strike: metrics.long_strike,
          ivr: ivr_value,
        })
      );
      throw new Error('HARD_FILTER: IVR_OUT_OF_RANGE');
    }
  }

  // Delta band gate:
  // - LIVE / DRY_RUN: |delta| ~ 0.25, allow [0.18, 0.28]
  // - SANDBOX_PAPER : relaxed band so we actually see proposals (e.g. [0.15, 0.35])
  const absDelta = Math.abs(metrics.delta_short);
  const lowerDelta = mode === 'SANDBOX_PAPER' ? 0.15 : 0.18;
  const upperDelta = mode === 'SANDBOX_PAPER' ? 0.35 : 0.28;
  if (absDelta < lowerDelta || absDelta > upperDelta) {
    console.log(
      '[scoring] HARD_REJECTION',
      JSON.stringify({
        reason: 'DELTA_OUT_OF_RANGE',
        symbol: metrics.symbol,
        expiration: metrics.expiration,
        short_strike: metrics.short_strike,
        long_strike: metrics.long_strike,
        delta_short: metrics.delta_short,
      })
    );
    throw new Error('HARD_FILTER: DELTA_OUT_OF_RANGE');
  }

  // Vertical skew value (already computed in metrics.verticalSkew / vertical_skew)
  const vertical_skew_value =
    metrics.verticalSkew ?? metrics.vertical_skew ?? 0;
  if (!Number.isFinite(vertical_skew_value)) {
    console.log(
      '[scoring] HARD_REJECTION',
      JSON.stringify({
        reason: 'VERTICAL_SKEW_INVALID',
        symbol: metrics.symbol,
        expiration: metrics.expiration,
        short_strike: metrics.short_strike,
        long_strike: metrics.long_strike,
        verticalSkew: vertical_skew_value,
      })
    );
    throw new Error('HARD_FILTER: VERTICAL_SKEW_INVALID');
  }
  // Extremely pathological skew – treat as outlier hard fail, but allow normal skew
  if (Math.abs(vertical_skew_value) > 2) {
    console.log(
      '[scoring] HARD_REJECTION',
      JSON.stringify({
        reason: 'VERTICAL_SKEW_OUTLIER',
        symbol: metrics.symbol,
        expiration: metrics.expiration,
        short_strike: metrics.short_strike,
        long_strike: metrics.long_strike,
        verticalSkew: vertical_skew_value,
      })
    );
    throw new Error('HARD_FILTER: VERTICAL_SKEW_OUTLIER');
  }

  // Credit floor gate
  const requiredCredit = width * minCreditFraction;
  if (!Number.isFinite(credit) || credit < requiredCredit) {
    console.log(
      '[scoring] HARD_REJECTION',
      JSON.stringify({
        reason: 'CREDIT_TOO_LOW',
        symbol: metrics.symbol,
        expiration: metrics.expiration,
        short_strike: metrics.short_strike,
        long_strike: metrics.long_strike,
        credit,
        width,
        minCreditFraction,
        requiredCredit,
      })
    );
    throw new Error('HARD_FILTER: CREDIT_TOO_LOW');
  }

  // -----------------------
  // Component scores
  // -----------------------

  // POP component (normalized 0–1)
  const clampedPop = Math.max(0.5, Math.min(0.9, rawPop));
  const popNorm = (clampedPop - 0.5) / 0.4;

  // Credit quality (S‑curve on credit fraction)
  const creditScore = creditQualityScore(credit, width);

  // IVR sweet spot (0–1)
  const ivr_score = ivrSweetSpotScore(ivr_value);

  // Delta suitability around |delta| ≈ 0.25
  const target = 0.25;
  const tolerance = 0.07;
  let deltaSuitability =
    1 - Math.abs(absDelta - target) / tolerance;
  deltaSuitability = clamp(deltaSuitability, 0, 1);

  // Liquidity from per-leg percentage spreads
  const liquidityScore = computeLiquidityScore(metrics);

  // Soft skew penalty – ideal near 0, fade out by |skew| >= 0.5
  const skewScore = computeSkewScore(vertical_skew_value);

  // Composite score
  // In SANDBOX_PAPER we neutralize IVR by giving it zero effective weight and
  // renormalizing the remaining components so IVR does not distort scores.
  const baseWeights = { ...WEIGHTS };
  if (mode === 'SANDBOX_PAPER') {
    baseWeights.ivr = 0;
  }
  const totalWeight =
    baseWeights.pop +
    baseWeights.credit +
    baseWeights.ivr +
    baseWeights.delta +
    baseWeights.liquidity +
    baseWeights.skew;

  const wp = baseWeights.pop / totalWeight;
  const wc = baseWeights.credit / totalWeight;
  const wi = baseWeights.ivr / totalWeight;
  const wd = baseWeights.delta / totalWeight;
  const wl = baseWeights.liquidity / totalWeight;
  const ws = baseWeights.skew / totalWeight;

  const composite_score =
    popNorm * wp +
    creditScore * wc +
    ivr_score * wi +
    deltaSuitability * wd +
    liquidityScore * wl +
    skewScore * ws;

  const ev = computeEV({
    pop: rawPop,
    credit,
    width,
  });

  // Structured scoring log for debugging
  console.log(
    '[scoring] v2',
    JSON.stringify({
      symbol: metrics.symbol,
      expiration: metrics.expiration,
      strikes: { short: metrics.short_strike, long: metrics.long_strike },
      rawPop,
      popNorm,
      ivr: ivr_value,
      ivrScore: ivr_score,
      credit,
      width,
      creditScore,
      delta_short: metrics.delta_short,
      deltaSuitability,
      short_pct_spread: metrics.short_pct_spread ?? 0,
      long_pct_spread: metrics.long_pct_spread ?? 0,
      liquidityScore,
      verticalSkew: vertical_skew_value,
      skewScore,
      finalScore: composite_score,
    }),
  );

  return {
    ivr_score,
    vertical_skew_score: skewScore, // soft penalty score (hard-gated above for outliers)
    term_structure_score: 1, // TODO: placeholder until term structure is wired - currently neutral (no impact on score)
    delta_fitness_score: deltaSuitability,
    ev_score: creditScore, // Note: this is a credit quality proxy, not normalized EV
    composite_score,
    ev,
    pop: rawPop,
  };
}

/**
 * IVR sweet‑spot scoring (0–1 IVR scale).
 * Centered around 0.45 (45 on a 0–100 scale).
 */
function ivrSweetSpotScore(ivr: number): number {
  if (!Number.isFinite(ivr)) return 0;
  const center = 0.45;
  const distance = Math.abs(ivr - center);
  const decay = 7.5;
  const raw = 1 - distance * decay;
  return clamp(raw, 0, 1);
}

/**
 * Credit quality curve – logistic S‑curve on credit fraction.
 */
function creditQualityScore(credit: number, width: number): number {
  if (!Number.isFinite(credit) || !Number.isFinite(width) || width <= 0) {
    return 0;
  }
  const pct = credit / width;
  const k = 15;
  const x = pct - 0.22;
  const logistic = 1 / (1 + Math.exp(-k * x));
  return clamp(logistic, 0, 1);
}

/**
 * Vertical skew soft score.
 *
 * Ideal is near 0. Full score for |skew| <= 0.10,
 * then linearly decays to 0 by |skew| >= 0.50.
 */
function computeSkewScore(verticalSkew: number): number {
  if (!Number.isFinite(verticalSkew)) return 0;

  // Note: computeVerticalSkew already returns absolute value (always >= 0)
  // No need for Math.abs here, but kept for defensive programming
  const absSkew = Math.abs(verticalSkew);

  if (absSkew <= 0.10) return 1;
  if (absSkew >= 0.50) return 0;

  const t = (absSkew - 0.10) / (0.50 - 0.10); // 0 → 1 between 0.10 and 0.50
  return clamp(1 - t, 0, 1);
}

/**
 * Score a debit spread candidate (BULL_CALL_DEBIT)
 * 
 * Component weights:
 * - Trend score: 30%
 * - Delta suitability: 25%
 * - R:R quality: 25%
 * - IVR suitability: 10%
 * - Liquidity: 10%
 */
export function scoreDebitCandidate(
  metrics: CandidateMetrics,
  opts?: { 
    mode?: TradingMode;
    trendScore?: number; // 0-1, from trend filter
    debit?: number; // debit paid (for R:R calculation) - REQUIRED
    width?: number; // spread width (default 5)
  }
): ScoringResult {
  const mode = opts?.mode ?? 'DRY_RUN';
  const width = opts?.width ?? 5;
  
  // Debit is required - fail early with clear error if missing
  if (!opts?.debit || !Number.isFinite(opts.debit) || opts.debit <= 0) {
    throw new Error('MISSING_DEBIT_FOR_DEBIT_SCORING: debit parameter is required and must be > 0');
  }
  const debit = opts.debit;
  
  // Hard filters for debit spreads
  // Normalize IVR to 0-1 scale if it comes in as 0-100
  let ivr_value = metrics.ivr;
  if (ivr_value != null && ivr_value > 1.0 && ivr_value <= 100.0) {
    // Assume 0-100 scale, normalize to 0-1
    ivr_value = ivr_value / 100.0;
  }
  if (mode !== 'SANDBOX_PAPER') {
    // IVR: 0.10 <= IVR <= 0.70
    if (!Number.isFinite(ivr_value) || ivr_value < 0.10 || ivr_value > 0.70) {
      throw new Error('HARD_FILTER: IVR_OUT_OF_RANGE');
    }
  }
  
  // Delta range: 0.40 <= |delta_long| <= 0.55
  // For debit spreads, we check the LONG leg delta (not short leg)
  // BULL_CALL_DEBIT: long_call delta is positive (0.40-0.55)
  // BEAR_PUT_DEBIT: long_put delta is negative, so we check abs(delta) (0.40-0.55)
  const deltaLong = metrics.delta_long != null 
    ? Math.abs(metrics.delta_long) 
    : (() => {
        // Fallback to short if long not available - log this to surface data issues
        console.log('[scoring][debit] delta_long missing, falling back to delta_short', JSON.stringify({
          symbol: metrics.symbol,
          expiration: metrics.expiration,
          delta_short: metrics.delta_short,
          note: 'This may indicate a data collection issue - debit spreads should have delta_long populated',
        }));
        return Math.abs(metrics.delta_short);
      })();
  if (deltaLong < 0.40 || deltaLong > 0.55) {
    throw new Error('HARD_FILTER: DELTA_OUT_OF_RANGE');
  }
  
  // Debit range: 0.80 <= debit <= 2.50
  if (debit < 0.80 || debit > 2.50) {
    throw new Error('HARD_FILTER: DEBIT_OUT_OF_RANGE');
  }
  
  // R:R >= 1.0
  const maxProfit = width - debit;
  const maxLoss = debit;
  const rewardToRisk = maxProfit / maxLoss;
  if (rewardToRisk < 1.0) {
    throw new Error('HARD_FILTER: REWARD_TO_RISK_TOO_LOW');
  }
  
  // Component scores
  const trendScore = opts?.trendScore ?? 0.5; // Default neutral if not provided
  const deltaScore = deltaSuitabilityScore(deltaLong, 0.475); // Target 0.475 (mid of 0.40-0.55)
  const rrScore = rewardToRiskScore(rewardToRisk);
  const ivrScore = ivrDebitScore(ivr_value);
  const liquidityScore = computeLiquidityScore(metrics);
  
  // Weighted composite
  const composite_score = 
    trendScore * 0.30 +
    deltaScore * 0.25 +
    rrScore * 0.25 +
    ivrScore * 0.10 +
    liquidityScore * 0.10;
  
  console.log('[scoring][debit]', JSON.stringify({
    symbol: metrics.symbol,
    expiration: metrics.expiration,
    debit,
    rewardToRisk,
    trendScore,
    deltaScore,
    rrScore,
    ivrScore,
    liquidityScore,
    composite_score,
  }));
  
  return {
    ivr_score: ivrScore,
    vertical_skew_score: 1, // Not applicable for debit spreads
    term_structure_score: 1,
    delta_fitness_score: deltaScore,
    ev_score: rrScore, // Note: this is a reward:risk proxy, not normalized EV
    composite_score,
    ev: maxProfit * 0.5 - maxLoss * 0.5, // Simplified EV estimate
    pop: 0.5, // Not used for debit spreads
  };
}

function deltaSuitabilityScore(delta: number, target: number): number {
  const distance = Math.abs(delta - target);
  const tolerance = 0.075; // ±0.075 around target
  return clamp(1 - distance / tolerance, 0, 1);
}

function rewardToRiskScore(rr: number): number {
  // Ideal: R:R >= 1.2, full score
  // Minimum: R:R = 1.0, partial score
  if (rr >= 1.2) return 1.0;
  if (rr <= 1.0) return 0.5;
  // Linear interpolation between 1.0 and 1.2
  return clamp(0.5 + (rr - 1.0) * 2.5, 0, 1);
}

function ivrDebitScore(ivr: number): number {
  // For debit spreads: prefer IVR 0.20-0.50 (not too high, not too low)
  if (!Number.isFinite(ivr)) return 0.6; // Soft floor
  if (ivr >= 0.20 && ivr <= 0.50) return 1.0;
  if (ivr < 0.10 || ivr > 0.70) return 0.6; // Soft floor instead of 0
  // Linear decay outside sweet spot
  let score: number;
  if (ivr < 0.20) {
    score = clamp(ivr / 0.20, 0, 1);
  } else {
    score = clamp(1 - (ivr - 0.50) / 0.20, 0, 1);
  }
  // Apply soft floor of 0.6
  return Math.max(0.6, score);
}

/**
 * Compute liquidity score based on combined bid-ask spreads
 * 
 * Formula: score = 1 - (totalPct * 12), clamped to [0, 1]
 * 
 * Examples:
 * - totalPct = 0.05 (5% combined) → score = 1 - 0.6 = 0.4
 * - totalPct = 0.02 (2% combined) → score = 1 - 0.24 = 0.76
 * - totalPct = 0.083 (8.3% combined) → score = 1 - 1.0 = 0.0 (minimum)
 * 
 * NOTE: The factor of 12 is intentionally punitive - very tight spreads are heavily rewarded.
 * If spreads are in "fraction of mid" units, this may need calibration against real market data.
 */
function computeLiquidityScore(metrics: CandidateMetrics): number {
  const shortPct = Math.max(0, metrics.short_pct_spread ?? 0);
  const longPct = Math.max(0, metrics.long_pct_spread ?? 0);
  const totalPct = shortPct + longPct;
  return clamp(1 - totalPct * 12, 0, 1);
}

/**
 * Check if composite score meets threshold
 * 
 * NOTE: This function uses hard-coded thresholds (0.70 for credit, 0.85 for debit).
 * The config-driven threshold is available via getMinScore(env) in core/config.ts.
 * 
 * Current usage:
 * - This function is used in the scoring layer to gate candidates after scoring
 * - getMinScore() is used in proposal generation and entry validation
 * 
 * TODO: Consider unifying these thresholds to avoid drift. Options:
 * 1. Make this function async and read from config
 * 2. Pass threshold as parameter from callers that have access to config
 * 3. Document clearly which threshold is authoritative for which use case
 * 
 * Per scoring-model.md (current hard-coded values):
 * - Composite Score ≥ 0.70 required for credit spreads
 * - Composite Score ≥ 0.85 required for debit spreads
 */
export function meetsScoreThreshold(composite_score: number, isDebit?: boolean): boolean {
  const threshold = isDebit ? 0.85 : 0.70;
  return composite_score >= threshold;
}

