/**
 * SAS v2 Proposal Generation Engine
 * 
 * Implements proposal-generation.md exactly.
 * 
 * Pipeline:
 * 1. Load Market State
 * 2. Validate Data Integrity
 * 3. Select Eligible Expirations (28-38 DTE)
 * 4. Build Raw Candidates (multi-symbol bull put spreads)
 * 5. Apply Hard Filters
 * 6. Compute Metrics
 * 7. Apply Scoring Model
 * 8. Enforce Score Threshold
 * 9. Select Highest-Scoring Candidate
 * 10. Emit Proposal or Emit None
 */

import type { Env } from '../env';
import type {
  ProposalResult,
  ProposalCandidate,
  ProposalRow,
  CandidateMetrics,
  OptionQuote,
  UnderlyingQuote,
} from '../types';
import { TradierClient } from '../broker/tradierClient';
import {
  computeDTE,
  isDTEInWindow,
  isDTEInWindowWithThresholds,
} from '../core/time';
import {
  computeIVR,
  computeVerticalSkew,
  computeTermStructure,
  computePOP,
  computeEV,
  isRVIVRatioValid,
} from '../core/metrics';
import { scoreCandidate, meetsScoreThreshold } from '../core/scoring';
import { insertProposal, insertSystemLog } from '../db/queries';
import { getTradingMode, getStrategyThresholds, getDefaultTradeQuantity, type TradingMode } from '../core/config';
import { getOpenTrades } from '../db/queries';
import { notifyProposalCreated } from '../notifications/telegram';
import { StrategyId, getEnabledStrategies, getStrategyConfig } from '../strategy/config';
import { buildBullPutCreditCandidates } from '../strategy/bullPutCredit';
import { buildBearCallCreditCandidates } from '../strategy/bearCallCredit';
import { buildBullCallDebitCandidates } from '../strategy/bullCallDebit';
import { buildBearPutDebitCandidates } from '../strategy/bearPutDebit';

const WIDTH = 5;
const MAX_EXPIRATIONS_PER_RUN = 5; // Limit expirations to avoid excessive chain calls

/**
 * Get eligible symbols for proposal generation based on trading mode and whitelist
 */
async function getEligibleSymbols(env: Env, mode: TradingMode): Promise<string[]> {
  // Base symbols by mode
  let baseSymbols: string[];
  if (mode === 'SANDBOX_PAPER') {
    baseSymbols = ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'];
  } else if (mode === 'LIVE') {
    baseSymbols = ['SPY']; // Only SPY for LIVE mode
  } else {
    // DRY_RUN uses PAPER symbols
    baseSymbols = ['SPY', 'AAPL', 'MSFT', 'NVDA', 'QQQ', 'AMD'];
  }
  
  // Apply underlying whitelist if configured
  const { getUnderlyingWhitelist } = await import('../core/config');
  const whitelist = await getUnderlyingWhitelist(env);
  
  if (whitelist.length > 0) {
    // Only return symbols that are in both baseSymbols and whitelist
    return baseSymbols.filter(s => whitelist.includes(s.toUpperCase()));
  }
  
  // No whitelist = use all base symbols
  return baseSymbols;
}

/**
 * Generate a proposal
 * 
 * Per system-interfaces.md:
 * export async function generateProposal(env: Env, now: Date): Promise<ProposalResult>;
 */
export async function generateProposal(
  env: Env,
  now: Date
): Promise<ProposalResult> {
  try {
    // Get strategy thresholds based on trading mode
    const thresholds = await getStrategyThresholds(env);
    const { minScore, minCreditFraction, minDte, maxDte, minDelta, maxDelta } = thresholds;
    
    // Get eligible symbols and trading mode
    const mode = await getTradingMode(env);
    const symbols = await getEligibleSymbols(env, mode);
    
    if (symbols.length === 0) {
      console.log('[proposals] no eligible symbols (whitelist may be too restrictive)', JSON.stringify({
        mode,
        underlyingWhitelist: await (await import('../core/config')).getUnderlyingWhitelist(env),
      }));
      return { proposal: null, candidate: null };
    }
    
    // Get enabled strategies for this mode
    let enabledStrategies = getEnabledStrategies(mode);
    console.log('[proposals][strategies][initial]', JSON.stringify({
      mode,
      initial_count: enabledStrategies.length,
      strategies: enabledStrategies,
    }));
    
    // Apply strategy whitelist if configured
    const { getStrategyWhitelist } = await import('../core/config');
    const strategyWhitelist = await getStrategyWhitelist(env);
    
    if (strategyWhitelist.length > 0) {
      console.log('[proposals][strategies][whitelist]', JSON.stringify({
        whitelist: strategyWhitelist,
        before_count: enabledStrategies.length,
      }));
      // Filter to only whitelisted strategies
      // StrategyId is a string enum, so we can use it directly
      enabledStrategies = enabledStrategies.filter(strategyId => {
        return strategyWhitelist.includes(strategyId);
      });
      console.log('[proposals][strategies][after_whitelist]', JSON.stringify({
        after_count: enabledStrategies.length,
        strategies: enabledStrategies,
      }));
    }
    
    // [1] Load Market State and generate candidates for all symbols
    const broker = new TradierClient(env);
    
    // Detect market regime for primary symbol (SPY) to gate strategies
    const primarySymbol = symbols[0] || 'SPY';
    const underlyingQuote = await broker.getUnderlyingQuote(primarySymbol);
    const { detectRegime, getStrategiesForRegime, isStrategyAllowedInRegime } = await import('../core/regime');
    const regimeState = await detectRegime(env, primarySymbol, underlyingQuote.last);
    
    // Log regime state and flip detection
    if (regimeState.flipped) {
      console.log('[regime][flip][detected]', JSON.stringify({
        symbol: primarySymbol,
        previous: regimeState.previousRegime,
        current: regimeState.regime,
        price: regimeState.price,
        sma20: regimeState.sma20,
        timestamp: regimeState.timestamp,
      }));
    }
    
    const { enabled: regimeEnabledStrategies } = getStrategiesForRegime(regimeState.regime);
    
    // Filter enabled strategies by regime
    // StrategyId is a string enum, so we can use it directly as the strategy name
    console.log('[proposals][strategies][before_regime_filter]', JSON.stringify({
      count: enabledStrategies.length,
      strategies: enabledStrategies,
      strategies_types: enabledStrategies.map(s => typeof s),
      regime: regimeState.regime,
      regime_enabled: regimeEnabledStrategies,
      regime_enabled_types: regimeEnabledStrategies.map(s => typeof s),
    }));
    enabledStrategies = enabledStrategies.filter(strategyId => {
      // strategyId is already a StrategyId enum value
      const allowed = isStrategyAllowedInRegime(strategyId, regimeState.regime);
      if (!allowed) {
        console.log('[regime][gating][filtered_out]', JSON.stringify({
          strategy: strategyId,
          regime: regimeState.regime,
          regime_enabled: regimeEnabledStrategies,
          in_array: regimeEnabledStrategies.includes(strategyId),
          reason: 'not_allowed_in_regime',
        }));
      } else {
        console.log('[regime][gating][allowed]', JSON.stringify({
          strategy: strategyId,
          regime: regimeState.regime,
        }));
      }
      return allowed;
    });
    
    console.log('[regime][gating]', JSON.stringify({
      regime: regimeState.regime,
      price: regimeState.price,
      sma20: regimeState.sma20,
      enabled_by_regime: regimeEnabledStrategies,
      enabled_after_gating: enabledStrategies, // StrategyId is already a string enum
      enabled_count: enabledStrategies.length,
    }));
    
    if (enabledStrategies.length === 0) {
      console.log('[proposals] no enabled strategies after regime gating', JSON.stringify({
        mode,
        regime: regimeState.regime,
        strategyWhitelist,
      }));
      return { proposal: null, candidate: null };
    }
    
    // [2] Validate Data Integrity - RV/IV ratio check
    // Note: For v1, we'll need to get RV_30d and IV_30d from market data
    // For now, we'll assume these are available or need to be computed
    // TODO: Get actual RV_30d and IV_30d from market data source
    const rv_30d = 0.15; // Placeholder - needs actual data
    const iv_30d = 0.20; // Placeholder - needs actual data
    
    if (!isRVIVRatioValid(rv_30d, iv_30d)) {
      return { proposal: null, candidate: null };
    }
    
    // Collect all candidates across all symbols and strategies
    const allCandidates: RawCandidate[] = [];
    const symbolSummaries: Array<{ symbol: string; candidateCount: number }> = [];
    const allExpirations: Array<{ expiration: string; dte: number }> = [];
    
    // Loop through each symbol
    for (const symbol of symbols) {
      try {
        // [1] Load Market State for this symbol
        const underlyingQuote = await broker.getUnderlyingQuote(symbol);
        
        // Validate underlying data
        if (!underlyingQuote.bid || !underlyingQuote.ask || !underlyingQuote.last) {
          console.log(`[proposals] skipping ${symbol}: missing underlying quote data`);
          continue;
        }
        
        // [3] Select Eligible Expirations (using mode-specific DTE window)
        const eligibleExpirations = await getEligibleExpirations(broker, symbol, now, minDte, maxDte);
        
        // Track expirations for summary
        for (const exp of eligibleExpirations) {
          if (!allExpirations.find(e => e.expiration === exp.expiration)) {
            allExpirations.push(exp);
          }
        }
        
        if (eligibleExpirations.length === 0) {
          console.log(`[proposals] ${symbol}: no eligible expirations`);
          continue;
        }
        
        // Cache regime and trend checks per symbol to avoid repeated API calls
        // Regime check for BEAR_CALL_CREDIT (reuse if already computed for primarySymbol)
        let cachedRegimeState = symbol === primarySymbol ? regimeState : null;
        if (!cachedRegimeState) {
          const { detectRegime } = await import('../core/regime');
          cachedRegimeState = await detectRegime(env, symbol, underlyingQuote.last);
        }
        
        // Cache trend checks per symbol (used for debit spreads)
        const { checkBullishTrend, checkBearishTrend } = await import('../core/trend');
        let cachedBullishTrend: Awaited<ReturnType<typeof checkBullishTrend>> | null = null;
        let cachedBearishTrend: Awaited<ReturnType<typeof checkBearishTrend>> | null = null;
        
        // [4] Build Raw Candidates for all enabled strategies
        // Fetch each chain once per expiration and build candidates for all strategies
        let symbolCandidateCount = 0;
        
        for (const { expiration, dte } of eligibleExpirations) {
          try {
            // Fetch chain once per expiration
            const chain = await broker.getOptionChain(symbol, expiration);
            
            // Build candidates for each enabled strategy
            for (const strategyId of enabledStrategies) {
              const config = getStrategyConfig(strategyId);
              
              // Check if this symbol is enabled for this strategy
              if (!config.symbols.includes(symbol)) {
                continue;
              }
              
              let strategyCandidates: RawCandidate[] = [];
              
              if (strategyId === StrategyId.BULL_PUT_CREDIT) {
                const verticalCandidates = buildBullPutCreditCandidates(config, chain, underlyingQuote, dte);
                strategyCandidates = verticalCandidates.map(vc => ({
                  symbol: vc.symbol,
                  expiration: vc.expiration,
                  short_strike: vc.short_strike,
                  long_strike: vc.long_strike,
                  width: vc.width,
                  credit: vc.credit,
                  strategy: 'BULL_PUT_CREDIT' as const,
                  short_put: vc.short_put,
                  long_put: vc.long_put,
                  dte: vc.dte,
                }));
                
                if (strategyCandidates.length > 0) {
                  console.log('[strategy][bull_put_credit][candidates]', JSON.stringify({
                    symbol,
                    expiration,
                    candidateCount: strategyCandidates.length,
                  }));
                }
              } else if (strategyId === StrategyId.BEAR_CALL_CREDIT) {
                // Apply softer directional gating for BEAR_CALL_CREDIT
                // Compute shortTermBias from price vs SMA (0 = strongly bullish, 1 = strongly bearish)
                // Use cached regime state to avoid repeated API calls
                let shortTermBias = 0.5; // Default neutral
                if (cachedRegimeState && cachedRegimeState.sma20 !== null) {
                  const priceVsSMA = (underlyingQuote.last - cachedRegimeState.sma20) / cachedRegimeState.sma20;
                  // shortTermBias: 1.0 if price << SMA (bearish), 0.0 if price >> SMA (bullish)
                  shortTermBias = Math.max(0, Math.min(1, 0.5 - (priceVsSMA / 0.04)));
                }
                // Allow if shortTermBias <= 0.50 (neutral-to-weakening trends)
                // Note: 0.5 = neutral, so we allow neutral and weakening (0.4-0.5) trends
                if (shortTermBias > 0.50) {
                  console.log('[strategy][bear_call_credit][bias_reject]', JSON.stringify({
                    symbol,
                    expiration,
                    shortTermBias,
                    reason: `Short-term bias ${shortTermBias.toFixed(3)} > 0.50 (too bearish)`,
                  }));
                  continue;
                }
                console.log('[strategy-gate]', JSON.stringify({
                  strategy: 'BEAR_CALL_CREDIT',
                  allowed: true,
                  shortTermBias,
                  symbol,
                  expiration,
                }));
                
                const verticalCandidates = buildBearCallCreditCandidates(config, chain, underlyingQuote, dte);
                strategyCandidates = verticalCandidates.map(vc => ({
                  symbol: vc.symbol,
                  expiration: vc.expiration,
                  short_strike: vc.short_strike,
                  long_strike: vc.long_strike,
                  width: vc.width,
                  credit: vc.credit,
                  strategy: 'BEAR_CALL_CREDIT' as const,
                  short_call: vc.short_call,
                  long_call: vc.long_call,
                  dte: vc.dte,
                }));
                
                if (strategyCandidates.length > 0) {
                  console.log('[strategy][bear_call_credit][candidates]', JSON.stringify({
                    symbol,
                    expiration,
                    candidateCount: strategyCandidates.length,
                  }));
                }
              } else if (strategyId === StrategyId.BULL_CALL_DEBIT) {
                // Apply trend filter for bullish strategies (softer gating)
                // Use cached trend check to avoid repeated API calls
                if (!cachedBullishTrend) {
                  cachedBullishTrend = await checkBullishTrend(env, symbol, underlyingQuote.last);
                }
                const trendCheck = cachedBullishTrend;
                // Allow if trendScore >= 0.35 (neutral-to-mild bullish)
                if (trendCheck.trendScore < 0.35) {
                  console.log('[strategy][bull_call_debit][trend_reject]', JSON.stringify({
                    symbol,
                    expiration,
                    trendScore: trendCheck.trendScore,
                    reason: trendCheck.reason || `Trend score ${trendCheck.trendScore.toFixed(3)} < 0.35`,
                  }));
                  continue;
                }
                console.log('[strategy-gate]', JSON.stringify({
                  strategy: 'BULL_CALL_DEBIT',
                  allowed: true,
                  trendScore: trendCheck.trendScore,
                  symbol,
                  expiration,
                }));
                
                const debitCandidates = buildBullCallDebitCandidates(config, chain, underlyingQuote, dte);
                strategyCandidates = debitCandidates.map(dc => ({
                  symbol: dc.symbol,
                  expiration: dc.expiration,
                  short_strike: dc.short_strike,
                  long_strike: dc.long_strike,
                  width: dc.width,
                  credit: -dc.debit, // Store as negative credit for debit spreads
                  strategy: 'BULL_CALL_DEBIT' as const,
                  short_call: dc.short_call,
                  long_call: dc.long_call,
                  dte: dc.dte,
                  debit: dc.debit, // Store debit separately
                }));
                
                if (strategyCandidates.length > 0) {
                  console.log('[strategy][bull_call_debit][candidates]', JSON.stringify({
                    symbol,
                    expiration,
                    candidateCount: strategyCandidates.length,
                  }));
                }
              } else if (strategyId === StrategyId.BEAR_PUT_DEBIT) {
                // Apply bearish trend filter (softer gating)
                // Use cached trend check to avoid repeated API calls
                if (!cachedBearishTrend) {
                  cachedBearishTrend = await checkBearishTrend(env, symbol, underlyingQuote.last);
                }
                const trendCheck = cachedBearishTrend;
                // Allow if trendScore >= 0.35 (neutral-to-mild bearish)
                if (trendCheck.trendScore < 0.35) {
                  console.log('[strategy][bear_put_debit][trend_reject]', JSON.stringify({
                    symbol,
                    expiration,
                    trendScore: trendCheck.trendScore,
                    reason: trendCheck.reason || `Trend score ${trendCheck.trendScore.toFixed(3)} < 0.35`,
                  }));
                  continue;
                }
                console.log('[strategy-gate]', JSON.stringify({
                  strategy: 'BEAR_PUT_DEBIT',
                  allowed: true,
                  trendScore: trendCheck.trendScore,
                  symbol,
                  expiration,
                }));
                
                const debitCandidates = buildBearPutDebitCandidates(config, chain, underlyingQuote, dte);
                strategyCandidates = debitCandidates.map(dc => ({
                  symbol: dc.symbol,
                  expiration: dc.expiration,
                  short_strike: dc.short_strike,
                  long_strike: dc.long_strike,
                  width: dc.width,
                  credit: -dc.debit, // Store as negative credit for debit spreads
                  strategy: 'BEAR_PUT_DEBIT' as const,
                  short_put: dc.short_put,
                  long_put: dc.long_put,
                  dte: dc.dte,
                  debit: dc.debit, // Store debit separately
                }));
                
                if (strategyCandidates.length > 0) {
                  console.log('[strategy][bear_put_debit][candidates]', JSON.stringify({
                    symbol,
                    expiration,
                    candidateCount: strategyCandidates.length,
                  }));
                }
              }
              
              allCandidates.push(...strategyCandidates);
              symbolCandidateCount += strategyCandidates.length;
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(`[proposals] error building candidates for ${symbol} ${expiration}: ${errorMsg}`);
            continue;
          }
        }
        
        symbolSummaries.push({ symbol, candidateCount: symbolCandidateCount });
        
        if (symbolCandidateCount > 0) {
          console.log(`[proposals] ${symbol}: built ${symbolCandidateCount} candidates`);
        }
      } catch (symbolError) {
        console.error(`[proposals] error processing ${symbol}:`, symbolError instanceof Error ? symbolError.message : String(symbolError));
        continue; // Continue with next symbol
      }
    }
    
    // If no candidates from any symbol, return early
    if (allCandidates.length === 0) {
      const summaryJson = JSON.stringify({
        symbols: symbolSummaries.map(s => s.symbol),
        candidateCount: 0,
        scoredCount: 0,
        bestScore: null,
        minScoreThreshold: minScore,
        minCreditFraction,
        dteWindow: { minDte, maxDte },
        mode,
        reason: 'NO_CANDIDATES_BUILT',
        symbolSummaries,
      });
      console.log('[proposals] summary', summaryJson);
      await insertSystemLog(env, 'proposals', '[proposals] summary', summaryJson).catch(() => {}); // Non-blocking
      return { proposal: null, candidate: null };
    }
    
    const candidates = allCandidates;
    
    // [5-7] Apply Filters, Compute Metrics, Score
    const scoredCandidates: ProposalCandidate[] = [];
    const allScoredCandidates: Array<{ score: number; expiration: string }> = []; // Track all scores for logging
    const allScoredCandidatesWithStrategy: Array<{ strategy: string; score: number }> = []; // Track all scored candidates with strategy for counting
    const filterRejections: Record<string, number> = {}; // Track which pre-scoring filters reject candidates
    const scoringRejections: Record<string, number> = {}; // Track which HARD_FILTERs fire inside scoring
    
    console.log('[proposals] scoring_candidates', JSON.stringify({
      symbols: symbolSummaries.map(s => s.symbol),
      mode,
      candidateCount: candidates.length,
      symbolBreakdown: symbolSummaries,
    }));
    
    for (const candidate of candidates) {
      // Log scoring attempt
      console.log('[strategy] candidate_score_attempt', JSON.stringify({
        symbol: candidate.symbol,
        expiration: candidate.expiration,
        shortStrike: candidate.short_strike,
        longStrike: candidate.long_strike,
        width: candidate.width,
        credit: candidate.credit,
        mode,
      }));
      
      try {
        // Apply hard filters (with mode-specific credit requirement)
        const filterResult = passesHardFiltersWithReason(candidate, rv_30d, iv_30d, minCreditFraction, mode);
        if (!filterResult.passed) {
          const reason = filterResult.reason || 'UNKNOWN_FILTER_FAILURE';
          filterRejections[reason] = (filterRejections[reason] || 0) + 1;
          const requiredCredit = candidate.width * minCreditFraction;
          console.log(`[proposals] candidate_rejected: ${reason}`, JSON.stringify({
            symbol: candidate.symbol,
            expiration: candidate.expiration,
            shortStrike: candidate.short_strike,
            longStrike: candidate.long_strike,
            width: candidate.width,
            credit: candidate.credit,
            min_credit_required: requiredCredit,
            reason,
          }));
          continue;
        }
        
        // Compute metrics
        let metrics: any;
        let scoring: any;
        let effectiveScore: number | null = null;
        
        try {
          // Require core data before computing metrics (handle PUT, CALL, and debit spreads)
          // BULL_PUT_CREDIT and BEAR_PUT_DEBIT use puts; BEAR_CALL_CREDIT and BULL_CALL_DEBIT use calls
          const shortOption = (candidate.strategy === 'BULL_PUT_CREDIT' || candidate.strategy === 'BEAR_PUT_DEBIT')
            ? candidate.short_put 
            : candidate.short_call;
          const longOption = (candidate.strategy === 'BULL_PUT_CREDIT' || candidate.strategy === 'BEAR_PUT_DEBIT')
            ? candidate.long_put
            : candidate.long_call;

          const hasRequiredData =
            shortOption?.delta != null &&
            shortOption?.implied_volatility != null &&
            longOption?.implied_volatility != null;

          if (!hasRequiredData) {
            console.log('[strategy] candidate_score_skip', JSON.stringify({
              symbol: candidate.symbol,
              expiration: candidate.expiration,
              shortStrike: candidate.short_strike,
              longStrike: candidate.long_strike,
              credit: candidate.credit,
              strategy: candidate.strategy,
              reason: 'MISSING_REQUIRED_DATA',
              hasDelta: shortOption?.delta != null,
              hasShortIv: shortOption?.implied_volatility != null,
              hasLongIv: longOption?.implied_volatility != null,
              mode,
            }));
            continue;
          }

          // Use different scoring for debit spreads
          if (candidate.strategy === 'BULL_CALL_DEBIT' || candidate.strategy === 'BEAR_PUT_DEBIT') {
            const { scoreDebitCandidate } = await import('../core/scoring');
            const { checkBullishTrend, checkBearishTrend } = await import('../core/trend');
            
            // Fetch underlying quote for trend check
            // OPTIMIZATION NOTE: This duplicates trend checks done during candidate building.
            // Consider caching trend checks per symbol in a Map and reusing them here to avoid repeated API calls.
            const underlyingQuoteForTrend = await broker.getUnderlyingQuote(candidate.symbol);
            let trendCheck;
            if (candidate.strategy === 'BULL_CALL_DEBIT') {
              trendCheck = await checkBullishTrend(env, candidate.symbol, underlyingQuoteForTrend.last);
            } else {
              trendCheck = await checkBearishTrend(env, candidate.symbol, underlyingQuoteForTrend.last);
            }
            const trendScore = trendCheck.trendScore; // Use actual trendScore, not valid/invalid
            
            // Compute metrics for debit spread
            metrics = computeCandidateMetrics(candidate, rv_30d, iv_30d);
            
            // Debug logging before scoring
            console.log('[strategy-gate]', JSON.stringify({
              strategy: candidate.strategy,
              allowed: true,
              trendScore,
              ivr: metrics.ivr,
              minScore,
              symbol: candidate.symbol,
              expiration: candidate.expiration,
            }));
            
            scoring = scoreDebitCandidate(metrics, {
              mode,
              trendScore,
              debit: candidate.debit ?? Math.abs(candidate.credit),
              width: candidate.width,
            });
            effectiveScore = scoring.composite_score;
          } else {
            metrics = computeCandidateMetrics(candidate, rv_30d, iv_30d);
            
            // Debug logging before scoring
            console.log('[strategy-gate]', JSON.stringify({
              strategy: candidate.strategy,
              allowed: true,
              ivr: metrics.ivr,
              minScore,
              symbol: candidate.symbol,
              expiration: candidate.expiration,
            }));
            
            scoring = scoreCandidate(metrics, { minCreditFraction, mode });
            effectiveScore = scoring.composite_score;
          }
        } catch (metricsError) {
          const msg = metricsError instanceof Error ? metricsError.message : String(metricsError);
          // If this came from a HARD_FILTER inside scoreCandidate, bucket by reason
          const hardMatch = msg.startsWith('HARD_FILTER: ')
            ? msg.replace('HARD_FILTER: ', '')
            : null;
          if (hardMatch) {
            scoringRejections[hardMatch] = (scoringRejections[hardMatch] || 0) + 1;
          }
          console.log('[strategy] candidate_score_skip', JSON.stringify({
            symbol: candidate.symbol,
            expiration: candidate.expiration,
            shortStrike: candidate.short_strike,
            longStrike: candidate.long_strike,
            credit: candidate.credit,
            reason: hardMatch ? `HARD_FILTER_${hardMatch}` : 'METRICS_OR_SCORING_ERROR',
            error: msg,
            mode,
          }));
          effectiveScore = null;
        }

        if (effectiveScore == null || Number.isNaN(effectiveScore) || !Number.isFinite(effectiveScore)) {
          // Not SANDBOX and score is invalid - skip
          console.log('[strategy] candidate_score_skip', JSON.stringify({
            symbol: candidate.symbol,
            expiration: candidate.expiration,
            shortStrike: candidate.short_strike,
            longStrike: candidate.long_strike,
            credit: candidate.credit,
            reason: 'SCORE_INVALID_AND_NOT_SANDBOX',
            mode,
          }));
          continue;
        }
        
        // Log scoring result
        const strategyLogKey =
          candidate.strategy === 'BULL_PUT_CREDIT'
            ? '[strategy][bull_put_credit][score]'
            : candidate.strategy === 'BEAR_CALL_CREDIT'
            ? '[strategy][bear_call_credit][score]'
            : candidate.strategy === 'BULL_CALL_DEBIT'
            ? '[strategy][bull_call_debit][score]'
            : '[strategy][bear_put_debit][score]';
        console.log(strategyLogKey, JSON.stringify({
          symbol: candidate.symbol,
          expiration: candidate.expiration,
          shortStrike: candidate.short_strike,
          longStrike: candidate.long_strike,
          credit: candidate.credit,
          rawScore: effectiveScore,
          mode,
        }));
        
        // At this point, effectiveScore should be valid (either from normal scoring or SANDBOX fallback)
        
        // Track all scored candidates (even if below threshold)
        allScoredCandidates.push({
          score: effectiveScore,
          expiration: candidate.expiration,
        });
        allScoredCandidatesWithStrategy.push({
          strategy: candidate.strategy,
          score: effectiveScore,
        });
        
        // Check threshold using mode-specific minScore (no sandbox bypass)
        // Normalize minScore: if > 1, treat as percentage (70 -> 0.70), otherwise use as-is (0.70 -> 0.70)
        // In SANDBOX_PAPER, all strategies use the same threshold (70%)
        let rawMinScore = minScore;
        if (mode === 'SANDBOX_PAPER' && (candidate.strategy === 'BULL_CALL_DEBIT' || candidate.strategy === 'BEAR_PUT_DEBIT')) {
          rawMinScore = 70; // Normalize debit spreads to 70% in PAPER mode
        }
        const effectiveMinScore = rawMinScore > 1 ? rawMinScore / 100 : rawMinScore;
        const requiredCredit = candidate.width * minCreditFraction;
        
        // Only log score rejections for near-miss trades (credit passes but score fails)
        if (effectiveScore < effectiveMinScore) {
          // Log near-miss trades (credit >= requiredCredit but score < threshold)
          if (candidate.credit >= requiredCredit) {
            console.log('[scoring][filtered_out]', JSON.stringify({
              symbol: candidate.symbol,
              expiration: candidate.expiration,
              shortStrike: candidate.short_strike,
              longStrike: candidate.long_strike,
              score: effectiveScore,
              minScore: effectiveMinScore,
              credit: candidate.credit,
              requiredCredit: requiredCredit,
              reason: 'SCORE_BELOW_MINIMUM',
              mode,
            }));
          }
          // Also log the standard rejection format for all score failures
          console.log('[proposals] candidate_rejected: SCORE_BELOW_MINIMUM', JSON.stringify({
            symbol: candidate.symbol,
            expiration: candidate.expiration,
            shortStrike: candidate.short_strike,
            longStrike: candidate.long_strike,
            credit: candidate.credit,
            score: effectiveScore,
            min_score_required: effectiveMinScore,
            mode,
          }));
          continue;
        }
        
        scoredCandidates.push({
          symbol: candidate.symbol,
          expiration: candidate.expiration,
          short_strike: candidate.short_strike,
          long_strike: candidate.long_strike,
          width: candidate.width,
          credit: candidate.credit,
          strategy: candidate.strategy,
          metrics,
          scoring: {
            ...scoring,
            composite_score: effectiveScore,
          },
        });
      } catch (error) {
        // Candidate rejected - log and continue
        console.log('[strategy] candidate_score_skip', JSON.stringify({
          symbol: candidate.symbol,
          expiration: candidate.expiration,
          shortStrike: candidate.short_strike,
          longStrike: candidate.long_strike,
          credit: candidate.credit,
          reason: 'UNEXPECTED_ERROR',
          error: error instanceof Error ? error.message : String(error),
          mode,
        }));
        continue;
      }
    }
    
    // [9] Select Highest-Scoring Candidate
    // Use credit requirement from strategy thresholds (same across modes)
    const effectiveCreditFraction = minCreditFraction;
    const requiredCredit = WIDTH * effectiveCreditFraction;
    
    // Normalize minScore: if > 1, treat as percentage (95 -> 0.95), otherwise use as-is (0.70 -> 0.70)
    // This handles both 0-1 scale (0.70) and 0-100 scale (70 or 95)
    const effectiveMinScore = minScore > 1 ? minScore / 100 : minScore;
    
    // Separate candidates that pass all rules vs those that don't
    const passing = scoredCandidates.filter(c => {
      const scorePasses = c.scoring.composite_score >= effectiveMinScore;
      
      // For debit spreads, check debit range (0.80 <= debit <= 2.50)
      // For credit spreads, check credit >= requiredCredit
      const isDebitSpread = c.strategy === 'BULL_CALL_DEBIT' || c.strategy === 'BEAR_PUT_DEBIT';
      let creditDebitPasses: boolean;
      
      if (isDebitSpread) {
        const debit = Math.abs(c.credit);
        creditDebitPasses = debit >= 0.80 && debit <= 2.50;
      } else {
        creditDebitPasses = c.credit >= requiredCredit;
      }
      
      return scorePasses && creditDebitPasses;
    });
    
    // [9.5] Portfolio Net Credit Check - ensure we stay net-credit after this trade
    // Filter out candidates that would make portfolio net-debit
    const portfolioFiltered = await filterByPortfolioNetCredit(env, passing, requiredCredit);
    
    // Sort all scored candidates by score (for fallback)
    const allScoredSorted = [...scoredCandidates].sort((a, b) => {
      if (b.scoring.composite_score !== a.scoring.composite_score) {
        return b.scoring.composite_score - a.scoring.composite_score;
      }
      if (b.scoring.ev !== a.scoring.ev) {
        return b.scoring.ev - a.scoring.ev;
      }
      return b.credit - a.credit;
    });
    
    let chosen: ProposalCandidate | null = null;
    let reason: string = 'NO_CANDIDATES_PASSED_FILTERS';
    
    if (portfolioFiltered.length > 0) {
      // Normal path: candidates that pass all rules including portfolio net credit
      portfolioFiltered.sort((a, b) => {
        if (b.scoring.composite_score !== a.scoring.composite_score) {
          return b.scoring.composite_score - a.scoring.composite_score;
        }
        if (b.scoring.ev !== a.scoring.ev) {
          return b.scoring.ev - a.scoring.ev;
        }
        return b.credit - a.credit;
      });
      chosen = portfolioFiltered[0];
      reason = 'NORMAL_RULES_PASSED';
    } else if (passing.length > 0) {
      // Had candidates but portfolio net credit check filtered them all
      reason = 'PORTFOLIO_NET_DEBIT_BLOCKED';
    }
    
    // Log summary and distribution
    const bestScore = allScoredSorted.length > 0 ? allScoredSorted[0].scoring.composite_score : null;
    
    // Scoring leaderboard for observability
    if (allScoredSorted.length > 0) {
      const leaderboard = allScoredSorted.slice(0, 10).map(c => ({
        symbol: c.symbol,
        expiration: c.expiration,
        short_strike: c.short_strike,
        long_strike: c.long_strike,
        score: c.scoring.composite_score,
        credit: c.credit,
      }));
      console.log('[scoring] leaderboard', JSON.stringify({ symbols: symbolSummaries.map(s => s.symbol), mode, top: leaderboard }));
    }

    // Score distribution histogram across all scored candidates (before minScore cut)
    const histogramBuckets = {
      '0.00-0.50': 0,
      '0.50-0.65': 0,
      '0.65-0.70': 0,
      '0.70-0.85': 0,
      '0.85-1.00': 0,
    };
    for (const s of allScoredCandidates) {
      const score = s.score;
      if (score < 0.5) histogramBuckets['0.00-0.50']++;
      else if (score < 0.65) histogramBuckets['0.50-0.65']++;
      else if (score < 0.7) histogramBuckets['0.65-0.70']++;
      else if (score < 0.85) histogramBuckets['0.70-0.85']++;
      else histogramBuckets['0.85-1.00']++;
    }

    // Count candidates by strategy (all scored candidates, not just those passing threshold)
    const countBullPut = allScoredCandidatesWithStrategy.filter(c => c.strategy === 'BULL_PUT_CREDIT').length;
    const countBearCall = allScoredCandidatesWithStrategy.filter(c => c.strategy === 'BEAR_CALL_CREDIT').length;
    const countBullCallDebit = allScoredCandidatesWithStrategy.filter(c => c.strategy === 'BULL_CALL_DEBIT').length;
    const countBearPutDebit = allScoredCandidatesWithStrategy.filter(c => c.strategy === 'BEAR_PUT_DEBIT').length;
    
    console.log('[post-change-strategy-counts]', JSON.stringify({
      BULL_PUT_CREDIT: countBullPut,
      BEAR_CALL_CREDIT: countBearCall,
      BULL_CALL_DEBIT: countBullCallDebit,
      BEAR_PUT_DEBIT: countBearPutDebit,
    }));

    console.log(
      '[scoring] distribution',
      JSON.stringify({
        symbols: symbolSummaries.map(s => s.symbol),
        mode,
        candidateCount: candidates.length,
        scoredCount: allScoredCandidates.length,
        passingCount: passing.length,
        histogram: histogramBuckets,
        scoringRejections,
      }),
    );

    const summaryJson = JSON.stringify({
      symbols: symbolSummaries.map(s => s.symbol),
      symbolBreakdown: symbolSummaries,
      candidateCount: candidates.length,
      scoredCount: allScoredCandidates.length,
      passingCount: passing.length,
      bestScore,
      minScoreThreshold: effectiveMinScore, // Show the mode-adjusted threshold
      minCreditFraction: effectiveCreditFraction, // Show the mode-adjusted fraction
      requiredCredit, // Show the actual required credit (WIDTH * effectiveCreditFraction)
      dteWindow: { minDte, maxDte },
      expirationsConsidered: allExpirations.map((e: { expiration: string; dte: number }) => ({ expiration: e.expiration, dte: e.dte })),
      chosenExpiration: chosen?.expiration ?? null,
      chosenScore: chosen?.scoring.composite_score ?? null,
      chosenCredit: chosen?.credit ?? null,
      filterRejections, // Show which filters rejected candidates
       scoringRejections, // HARD_FILTER reasons from scoring
       scoreHistogram: histogramBuckets,
      mode,
      reason,
    });
    console.log('[proposals] summary', summaryJson);
    // Store in DB for UI visibility
    await insertSystemLog(env, 'proposals', '[proposals] summary', summaryJson).catch(() => {}); // Non-blocking

    if (!chosen) {
      console.log('[proposals] no-trade-summary', JSON.stringify({
        reason,
        totalCandidatesBuilt: candidates.length,
        passedHardFilters: candidates.length - Object.values(filterRejections).reduce((a, b) => a + b, 0),
        passedScoring: passing.length,
        bestScore,
        minScoreRequired: effectiveMinScore,
        expirationsConsidered: allExpirations.map((e: { expiration: string; dte: number }) => ({ expiration: e.expiration, dte: e.dte })),
      }));
      return { proposal: null, candidate: null };
    }
    
    const bestCandidate = chosen;
    
    // [10] Persist Proposal
    // Get configurable default quantity (defaults to 1 if not set)
    const defaultQuantity = await getDefaultTradeQuantity(env);
    const proposal: Omit<ProposalRow, 'created_at'> = {
      id: crypto.randomUUID(),
      symbol: bestCandidate.symbol,
      expiration: bestCandidate.expiration,
      short_strike: bestCandidate.short_strike,
      long_strike: bestCandidate.long_strike,
      width: bestCandidate.width,
      quantity: defaultQuantity,
      strategy: bestCandidate.strategy,
      credit_target: bestCandidate.credit,
      score: bestCandidate.scoring.composite_score,
      ivr_score: bestCandidate.scoring.ivr_score,
      vertical_skew_score: bestCandidate.scoring.vertical_skew_score,
      term_structure_score: bestCandidate.scoring.term_structure_score,
      delta_fitness_score: bestCandidate.scoring.delta_fitness_score,
      ev_score: bestCandidate.scoring.ev_score,
      status: 'READY',
    };
    
    const persistedProposal = await insertProposal(env, proposal);
    const tradingMode = await getTradingMode(env);
    await notifyProposalCreated(env, tradingMode, persistedProposal);
    
    return {
      proposal: persistedProposal,
      candidate: bestCandidate,
    };
  } catch (error) {
    // Any error = no proposal
    // Get thresholds for logging even on error
    const thresholds = await getStrategyThresholds(env).catch(() => ({
      minScore: 0.70,
      minCreditFraction: 0.18,
      minDte: 28,
      maxDte: 38,
    }));
    
    const mode = await getTradingMode(env).catch(() => 'DRY_RUN' as TradingMode);
    const symbols = await getEligibleSymbols(env, mode);
    
    const summaryJson = JSON.stringify({
      symbols,
      expiration: null,
      candidateCount: 0,
      scoredCount: 0,
      bestScore: null,
      minScoreThreshold: thresholds.minScore,
      minCreditFraction: thresholds.minCreditFraction,
      dteWindow: { minDte: thresholds.minDte, maxDte: thresholds.maxDte },
      reason: 'ERROR',
      error: error instanceof Error ? error.message : String(error)
    });
    console.log('[proposals] summary', summaryJson);
    await insertSystemLog(env, 'proposals', '[proposals] summary', summaryJson).catch(() => {}); // Non-blocking
    return { proposal: null, candidate: null };
  }
}

/**
 * Raw candidate structure (before metrics/scoring)
 * Supports both PUT and CALL credit spreads
 */
interface RawCandidate {
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  credit: number;
  strategy: 'BULL_PUT_CREDIT' | 'BEAR_CALL_CREDIT' | 'BULL_CALL_DEBIT' | 'BEAR_PUT_DEBIT';
  // For BULL_PUT_CREDIT and BEAR_PUT_DEBIT: short_put and long_put are set
  short_put?: OptionQuote;
  long_put?: OptionQuote;
  // For BEAR_CALL_CREDIT and BULL_CALL_DEBIT: short_call and long_call are set
  short_call?: OptionQuote;
  long_call?: OptionQuote;
  dte: number;
  debit?: number; // For debit spreads (BULL_CALL_DEBIT, BEAR_PUT_DEBIT)
}

/**
 * Get eligible expirations with DTE info, limited to MAX_EXPIRATIONS_PER_RUN
 * 
 * Returns array of { expiration: string, dte: number } sorted by DTE (nearest first)
 * 
 * Strategy: Find all Fridays in the DTE window, then verify each has options available
 */
async function getEligibleExpirations(
  broker: TradierClient,
  symbol: string,
  now: Date,
  minDte: number,
  maxDte: number
): Promise<Array<{ expiration: string; dte: number }>> {
  const candidates: Array<{ expiration: string; dte: number }> = [];
  const seenExpirations = new Set<string>();
  
  // Reduced logging - removed verbose expiration calculation logs
  
  // Find the first Friday at or after minDte
  const minDate = new Date(now);
  minDate.setDate(minDate.getDate() + minDte);
  const minDayOfWeek = minDate.getDay();
  const daysToFirstFriday = (5 - minDayOfWeek + 7) % 7;
  if (daysToFirstFriday > 0) {
    minDate.setDate(minDate.getDate() + daysToFirstFriday);
  }
  
  // Find all Fridays in the DTE window (SPY options expire on Fridays)
  const fridays: Date[] = [];
  const currentFriday = new Date(minDate);
  const allFridaysWithDte: Array<{ expiration: string; dte: number }> = [];
  
  while (true) {
    const expirationStr = currentFriday.toISOString().split('T')[0];
    const dte = computeDTE(expirationStr, now);
    
    // Track all Fridays we consider (for logging)
    allFridaysWithDte.push({ expiration: expirationStr, dte });
    
    if (dte > maxDte) {
      break;
    }
    if (dte >= minDte) {
      fridays.push(new Date(currentFriday));
      // Reduced logging - removed individual Friday logs
    }
    // Move to next Friday (7 days later)
    currentFriday.setDate(currentFriday.getDate() + 7);
  }
  
  // Reduced logging - removed verbose expiration calculation logs
  
  // Verify each Friday has options available (limit to MAX_EXPIRATIONS_PER_RUN)
  for (let i = 0; i < Math.min(fridays.length, MAX_EXPIRATIONS_PER_RUN * 2); i++) {
    const friday = fridays[i];
    const expirationStr = friday.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Skip if we've already checked this expiration
    if (seenExpirations.has(expirationStr)) {
      continue;
    }
    seenExpirations.add(expirationStr);
    
    const dte = computeDTE(expirationStr, now);
    
    // Double-check DTE window
    if (!isDTEInWindowWithThresholds(dte, minDte, maxDte)) {
      console.log(`[proposals] skipping ${expirationStr}: DTE ${dte} outside window [${minDte}, ${maxDte}]`);
      continue;
    }
    
    // Try to fetch chain for this expiration to verify it exists
    try {
      console.log(`[proposals] checking chain for ${expirationStr} (DTE=${dte})...`);
      const chain = await broker.getOptionChain(symbol, expirationStr);
      console.log(`[proposals] chain for ${expirationStr}: ${chain.length} options after filtering`);
      
      // Check option type distribution
      const putOptions = chain.filter(opt => opt.type === 'put');
      const callOptions = chain.filter(opt => opt.type === 'call');
      console.log(`[proposals] chain for ${expirationStr}: ${putOptions.length} PUT options, ${callOptions.length} CALL options`);
      
      if (chain.length > 0) {
        candidates.push({ expiration: expirationStr, dte });
        console.log(`[proposals] ✓ added expiration ${expirationStr} (DTE=${dte}), total candidates: ${candidates.length}`);
        // Stop once we have enough
        if (candidates.length >= MAX_EXPIRATIONS_PER_RUN) {
          break;
        }
      } else {
        console.log(`[proposals] ✗ expiration ${expirationStr} has no options in chain (or all filtered out)`);
      }
    } catch (error) {
      // Expiration doesn't exist or error - skip
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`[proposals] ✗ expiration ${expirationStr} not available: ${errorMsg}`);
      continue;
    }
  }
  
  // Reduced logging - only log summary if no candidates found (potential issue)
  if (candidates.length === 0) {
    console.log('[proposals] expirations_summary', JSON.stringify({
      symbol,
      fridaysCalculated: allFridaysWithDte.length,
      fridaysInWindow: fridays.length,
      chainsChecked: Math.min(fridays.length, MAX_EXPIRATIONS_PER_RUN * 2),
      chainsWithOptions: candidates.length,
    }));
  }
  
  // Sort by DTE (nearest first) - should already be sorted, but ensure it
  return candidates.sort((a, b) => a.dte - b.dte);
}

/**
 * Build raw candidates from option chains
 * 
 * Fetches each chain once and builds all candidates from it (no repeated chain calls)
 * 
 * @param quoteFetchTime - Timestamp when quotes were fetched (for freshness check)
 */
/**
 * Legacy candidate builder - NOT USED
 * 
 * This function is kept for reference but is not called anywhere in the current codebase.
 * Candidate building is now handled by strategy-specific builders (buildBullPutCreditCandidates, etc.)
 * in the main generateProposal function.
 */
async function buildCandidates(
  broker: TradierClient,
  symbol: string,
  underlying: UnderlyingQuote,
  now: Date,
  rv_30d: number,
  iv_30d: number,
  eligibleExpirations: Array<{ expiration: string; dte: number }>,
  minDelta: number,
  maxDelta: number,
  quoteFetchTime: number
): Promise<RawCandidate[]> {
  const candidates: RawCandidate[] = [];
  const MAX_QUOTE_AGE_MS = 90 * 1000; // 90 seconds
  
  // For each expiration, fetch chain ONCE and build candidates
  for (const { expiration, dte } of eligibleExpirations) {
    const chainFetchTime = Date.now();
    const chain = await broker.getOptionChain(symbol, expiration);
    const puts = chain.filter(opt => opt.type === 'put');
    
    // Build candidates with delta in range minDelta to maxDelta (e.g. -0.30 to -0.20)
    for (const shortPut of puts) {
      // Check delta range (delta is negative for puts, so minDelta < maxDelta)
      if (!shortPut.delta || shortPut.delta < minDelta || shortPut.delta > maxDelta) {
        continue;
      }
      
      // Check quote freshness - reject if quotes are older than 90 seconds
      const quoteAge = Date.now() - chainFetchTime;
      if (quoteAge > MAX_QUOTE_AGE_MS) {
        console.log('[proposals] stale_quote_rejected', JSON.stringify({
          symbol,
          expiration,
          quoteAgeMs: quoteAge,
          maxAgeMs: MAX_QUOTE_AGE_MS,
        }));
        continue;
      }
      
      // Find long put (short_strike - 5)
      const longStrike = shortPut.strike - WIDTH;
      const longPut = puts.find(opt => opt.strike === longStrike);
      
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
      
      candidates.push({
        symbol,
        expiration,
        short_strike: shortPut.strike,
        long_strike: longPut.strike,
        width: WIDTH,
        credit,
        strategy: 'BULL_PUT_CREDIT' as const,
        short_put: shortPut,
        long_put: longPut,
        dte, // Use DTE from eligibleExpirations (already computed)
      });
    }
  }
  
  return candidates;
}

/**
 * Pre-scoring hard filters
 * 
 * These filters run before scoring to reject candidates that fail structural/quote-based checks.
 * 
 * NOTE: There are two layers of hard filters:
 * 1. Pre-scoring filters (this function): structural/quote-based checks (liquidity, missing legs, quote validity)
 * 2. In-scoring filters (scoreCandidate/scoreDebitCandidate): strategy/statistics-driven rules (POP, IVR, delta band, skew outliers)
 * 
 * Some overlap exists (e.g., credit/debit requirements, vertical skew). The in-scoring filters are the authoritative source
 * for strategy-specific thresholds, while pre-scoring filters provide early rejection for obviously invalid candidates.
 * 
 * @param mode - Trading mode (SANDBOX_PAPER has relaxed filters)
 */
function passesHardFiltersWithReason(
  candidate: RawCandidate,
  rv_30d: number,
  iv_30d: number,
  minCreditFraction: number,
  mode: 'DRY_RUN' | 'SANDBOX_PAPER' | 'LIVE' = 'DRY_RUN'
): { passed: boolean; reason?: string } {
  const isSandbox = mode === 'SANDBOX_PAPER';
  
  // Get the appropriate option quotes based on strategy
  // BULL_PUT_CREDIT and BEAR_PUT_DEBIT use puts; BEAR_CALL_CREDIT and BULL_CALL_DEBIT use calls
  const shortOption = (candidate.strategy === 'BULL_PUT_CREDIT' || candidate.strategy === 'BEAR_PUT_DEBIT')
    ? candidate.short_put 
    : candidate.short_call;
  const longOption = (candidate.strategy === 'BULL_PUT_CREDIT' || candidate.strategy === 'BEAR_PUT_DEBIT')
    ? candidate.long_put
    : candidate.long_call;
  
  if (!shortOption || !longOption) {
    console.log('[hard-filter][missing-legs]', JSON.stringify({
      strategy: candidate.strategy,
      shortStrike: candidate.short_strike,
      longStrike: candidate.long_strike,
      hasShortPut: !!candidate.short_put,
      hasLongPut: !!candidate.long_put,
      hasShortCall: !!candidate.short_call,
      hasLongCall: !!candidate.long_call,
      shortOption: !!shortOption,
      longOption: !!longOption,
    }));
    return { passed: false, reason: 'MISSING_OPTION_LEGS' };
  }
  
  // 6.1 RV/IV - already checked at top level
  
  // 6.2 IVR - checked during scoring
  
  // 6.3 Liquidity
  const shortSpread = shortOption.ask - shortOption.bid;
  const longSpread = longOption.ask - longOption.bid;
  
  // Log liquidity metrics for debugging
  const shortMid = (shortOption.bid + shortOption.ask) / 2;
  const longMid = (longOption.bid + longOption.ask) / 2;
  const shortPctSpread = shortMid > 0 ? shortSpread / shortMid : 0;
  const longPctSpread = longMid > 0 ? longSpread / longMid : 0;
  
  console.log('[strategy] candidate_liquidity', JSON.stringify({
    symbol: candidate.symbol,
    expiration: candidate.expiration,
    strategy: candidate.strategy,
    shortStrike: candidate.short_strike,
    longStrike: candidate.long_strike,
    shortBid: shortOption.bid,
    shortAsk: shortOption.ask,
    longBid: longOption.bid,
    longAsk: longOption.ask,
    shortSpread,
    longSpread,
    shortPctSpread,
    longPctSpread,
    credit: candidate.credit,
    mode,
  }));
  
  // SANDBOX: Relaxed spread filter (allow up to 0.50 absolute or 100% of mid)
  if (!isSandbox) {
    if (shortSpread > 0.15 || longSpread > 0.15) {
      return { passed: false, reason: 'LIQUIDITY_SPREAD_TOO_WIDE' };
    }
  } else {
    // SANDBOX: Much looser - only reject if spread is > 0.50 AND > 100% of mid
    const maxAbsSpread = 0.50;
    const maxPctSpread = 1.0;
    if ((shortSpread > maxAbsSpread && shortPctSpread > maxPctSpread) ||
        (longSpread > maxAbsSpread && longPctSpread > maxPctSpread)) {
      return { passed: false, reason: 'LIQUIDITY_SPREAD_TOO_WIDE' };
    }
  }
  
  if (shortOption.bid <= 0 || shortOption.ask <= 0) {
    return { passed: false, reason: 'SHORT_LEG_INVALID_QUOTES' };
  }
  if (longOption.bid <= 0 || longOption.ask <= 0) {
    return { passed: false, reason: 'LONG_LEG_INVALID_QUOTES' };
  }
  
  // 6.4 Vertical Skew
  // SANDBOX: Allow missing IV, use default for scoring
  if (!isSandbox) {
    if (!shortOption.implied_volatility || !longOption.implied_volatility) {
      return { passed: false, reason: 'MISSING_IMPLIED_VOLATILITY' };
    }
  } else {
    // SANDBOX: If IV is missing, use a reasonable default (0.5 = 50%) so scoring can run
    if (!shortOption.implied_volatility) {
      shortOption.implied_volatility = 0.5;
    }
    if (!longOption.implied_volatility) {
      longOption.implied_volatility = 0.5;
    }
  }
  
  // Log skew inputs for debugging
  const shortIv = shortOption.implied_volatility;
  const longIv = longOption.implied_volatility;
  const skewDiff = shortIv != null && longIv != null ? longIv - shortIv : null;
  const skewRatio = shortIv != null && longIv != null && shortIv !== 0 ? longIv / shortIv : null;
  
  console.log('[strategy] vertical_skew', JSON.stringify({
    symbol: candidate.symbol,
    expiration: candidate.expiration,
    strategy: candidate.strategy,
    shortStrike: candidate.short_strike,
    longStrike: candidate.long_strike,
    shortIv,
    longIv,
    skewDiff,
    skewRatio,
    bounds: {
      minSkew: 0,
      maxSkewSandbox: 0.10,
      maxSkewLive: 0.05,
    },
    mode,
    isSandbox,
  }));
  
  // Apply vertical skew filter – now based on distance from flat (ratio-based)
  const vertical_skew = computeVerticalSkew({
    iv_short: shortIv!,
    iv_long: longIv!,
  });

  const maxSkewLive = 0.05;
  const maxSkewSandbox = 0.10;
  const maxAllowedSkew = isSandbox ? maxSkewSandbox : maxSkewLive;
  
  // Note: computeVerticalSkew returns absolute value (always >= 0)
  // Invalid if NaN or exceeds maximum allowed skew
  const isInvalid = !Number.isFinite(vertical_skew);
  const aboveMax = vertical_skew > maxAllowedSkew;

  console.log('[strategy] vertical_skew_check', JSON.stringify({
    symbol: candidate.symbol,
    expiration: candidate.expiration,
    vertical_skew,
    isNaN: !Number.isFinite(vertical_skew),
    aboveMax,
    bounds: {
      maxAllowedSkew,
      maxSkewLive,
      maxSkewSandbox,
    },
    mode,
  }));
  
  if (isInvalid) {
    console.log('[strategy] vertical_skew_reject', JSON.stringify({
      symbol: candidate.symbol,
      expiration: candidate.expiration,
      vertical_skew,
      mode,
      reason: 'VERTICAL_SKEW_INVALID',
    }));
    return { passed: false, reason: 'VERTICAL_SKEW_OUT_OF_RANGE' };
  }

  if (aboveMax) {
    if (isSandbox) {
      // In SANDBOX_PAPER, treat as a warning only – allow candidate to continue.
      console.log('[strategy] vertical_skew_warn', JSON.stringify({
        symbol: candidate.symbol,
        expiration: candidate.expiration,
        vertical_skew,
        maxAllowedSkew,
        mode,
      }));
    } else {
      console.log('[strategy] vertical_skew_reject', JSON.stringify({
        symbol: candidate.symbol,
        expiration: candidate.expiration,
        vertical_skew,
        maxAllowedSkew,
        mode,
        reason: 'VERTICAL_SKEW_OUT_OF_RANGE',
      }));
      return { passed: false, reason: 'VERTICAL_SKEW_OUT_OF_RANGE' };
    }
  }
  
  // 6.5 Term Structure - needs back month IV (TODO)
  
  // 6.6 Delta Fitness - checked during scoring
  
  // 6.7 Credit/Debit Requirement
  const isDebitSpread = candidate.strategy === 'BULL_CALL_DEBIT' || candidate.strategy === 'BEAR_PUT_DEBIT';
  
  if (isDebitSpread) {
    // For debit spreads: check debit (absolute value of negative credit)
    // Requirements: 0.80 <= debit <= 2.50
    const debit = Math.abs(candidate.credit);
    const minDebit = 0.80;
    const maxDebit = 2.50;
    
    if (debit < minDebit) {
      return { passed: false, reason: 'DEBIT_BELOW_MINIMUM' };
    }
    if (debit > maxDebit) {
      return { passed: false, reason: 'DEBIT_ABOVE_MAXIMUM' };
    }
  } else {
    // For credit spreads: check credit >= requiredCredit
    const effectiveCreditFraction = minCreditFraction;
    const requiredCredit = candidate.width * effectiveCreditFraction;
    
    if (candidate.credit < requiredCredit) {
      return { passed: false, reason: 'CREDIT_BELOW_MINIMUM' };
    }
  }
  
  return { passed: true };
}

/**
 * Legacy function for backward compatibility
 */
function passesHardFilters(
  candidate: RawCandidate,
  rv_30d: number,
  iv_30d: number,
  minCreditFraction: number,
  mode: 'DRY_RUN' | 'SANDBOX_PAPER' | 'LIVE' = 'DRY_RUN'
): boolean {
  return passesHardFiltersWithReason(candidate, rv_30d, iv_30d, minCreditFraction, mode).passed;
}

/**
 * Compute minimum credit requirement
 * 
 * NOTE: This function is currently UNUSED. Credit requirements are handled via minCreditFraction
 * in passesHardFiltersWithReason and scoreCandidate. This function is kept for reference.
 */
function computeMinCredit(ivr: number, vertical_skew: number, width: number): number {
  const base = 0.20 * width;
  const ivr_adjust = (ivr - 0.30) * 0.10 * width;
  const skew_adjust = vertical_skew * 0.10 * width;
  
  let min_credit = base + ivr_adjust + skew_adjust;
  min_credit = Math.max(0.80, Math.min(2.00, min_credit));
  
  return min_credit;
}

/**
 * Compute CandidateMetrics from raw candidate
 */
function computePctSpread(bid: number | null | undefined, ask: number | null | undefined): number {
  if (!Number.isFinite(bid as number) || !Number.isFinite(ask as number)) {
    return 0;
  }
  const b = bid as number;
  const a = ask as number;
  if (a <= 0) {
    return 0;
  }
  const spread = a - b;
  if (!Number.isFinite(spread) || spread <= 0) {
    return 0;
  }
  const pct = spread / a;
  return pct > 0 ? pct : 0;
}

export function computeCandidateMetrics(
  candidate: RawCandidate,
  rv_30d: number,
  iv_30d: number
): CandidateMetrics {
  // Handle both PUT and CALL spreads
  // BULL_PUT_CREDIT and BEAR_PUT_DEBIT use puts; BEAR_CALL_CREDIT and BULL_CALL_DEBIT use calls
  const shortOption = (candidate.strategy === 'BULL_PUT_CREDIT' || candidate.strategy === 'BEAR_PUT_DEBIT')
    ? candidate.short_put 
    : candidate.short_call;
  const longOption = (candidate.strategy === 'BULL_PUT_CREDIT' || candidate.strategy === 'BEAR_PUT_DEBIT')
    ? candidate.long_put
    : candidate.long_call;

  if (
    !shortOption ||
    !longOption ||
    shortOption.delta == null ||
    shortOption.implied_volatility == null ||
    longOption.implied_volatility == null
  ) {
    throw new Error('Missing required option data');
  }

  const shortIv = shortOption.implied_volatility;
  const longIv = longOption.implied_volatility;

  const vertical_skew = computeVerticalSkew({
    iv_short: shortIv,
    iv_long: longIv,
  });

  // TODO: Get actual term structure from back month
  const term_structure = 0.0; // Placeholder

  // TODO: Get actual IVR from 52-week data (0–1 scale)
  // NOTE: IVR is currently a placeholder (0.5). Real IVR calculation is not yet wired.
  // This means IVR-based hard filters and scoring components are effectively neutralized.
  // When real IVR is implemented, update this to use actual IVR calculation.
  const ivr = 0.5; // Placeholder until real IVR is wired
  if (ivr === 0.5) {
    console.log('[metrics][ivr_placeholder]', JSON.stringify({
      symbol: candidate.symbol,
      expiration: candidate.expiration,
      strategy: candidate.strategy,
      note: 'IVR_PLACEHOLDER_USED - IVR hard filters and scoring are effectively neutralized',
    }));
  }

  // For scoring, use absolute delta (scoring already uses Math.abs)
  // This allows call deltas (positive) and put deltas (negative) to be treated consistently
  const pop = computePOP(shortOption.delta);
  
  // Calculate max_profit and max_loss correctly for both credit and debit spreads
  let max_profit: number;
  let max_loss: number;
  let ev: number;
  
  if (candidate.strategy === 'BULL_CALL_DEBIT' || candidate.strategy === 'BEAR_PUT_DEBIT') {
    // For debit spreads:
    // - max_profit = width - debit
    // - max_loss = debit
    const debit = candidate.debit ?? Math.abs(candidate.credit);
    max_profit = candidate.width - debit;
    max_loss = debit;
    // EV for debit spreads is computed differently (not using computeEV which is credit-focused)
    // Use a simplified EV estimate: maxProfit * pop - maxLoss * (1 - pop)
    ev = max_profit * pop - max_loss * (1 - pop);
  } else {
    // For credit spreads:
    // - max_profit = credit
    // - max_loss = width - credit
    max_profit = candidate.credit;
    max_loss = candidate.width - candidate.credit;
    ev = computeEV({
      pop,
      credit: candidate.credit,
      width: candidate.width,
    });
  }

  const short_pct_spread = computePctSpread(shortOption.bid, shortOption.ask);
  const long_pct_spread = computePctSpread(longOption.bid, longOption.ask);

  return {
    symbol: candidate.symbol,
    expiration: candidate.expiration,
    short_strike: candidate.short_strike,
    long_strike: candidate.long_strike,
    width: candidate.width,
    credit: candidate.credit,
    ivr,
    rv_30d,
    iv_30d,
    vertical_skew,
    verticalSkew: vertical_skew,
    short_pct_spread,
    long_spread: longOption.ask - longOption.bid,
    long_pct_spread,
    term_structure,
    delta_short: shortOption.delta, // Will be negative for puts, positive for calls
    delta_long: longOption.delta ?? undefined, // Will be negative for puts, positive for calls
    pop,
    max_profit,
    max_loss,
  };
}

/**
 * Filter candidates by portfolio net credit rule
 * 
 * Ensures that after adding a new spread, the portfolio remains net-credit.
 * 
 * NOTE: This function handles both credit and debit trades in the existing portfolio.
 * - Credit spreads: entry_price is credit received (positive contribution to net premium)
 * - Debit spreads: entry_price is debit paid (negative contribution to net premium)
 * 
 * Debit spreads are identified by checking if max_profit > max_loss (typical for debit spreads).
 * 
 * For each OPEN trade:
 * - Credit spread: +entry_price * quantity * 100 (credit received)
 * - Debit spread: -entry_price * quantity * 100 (debit paid)
 * 
 * For a new spread proposal:
 * - Credit spreads: +credit * quantity * 100
 * - Debit spreads: skipped (allowed even if they make portfolio net-debit)
 * 
 * Portfolio net premium after trade = existing net premium + new spread net premium
 * Must be >= 0 to allow the trade (for credit spreads only).
 */
async function filterByPortfolioNetCredit(
  env: Env,
  candidates: ProposalCandidate[],
  minCredit: number
): Promise<ProposalCandidate[]> {
  // Get all OPEN trades
  const openTrades = await getOpenTrades(env);
  
  // Get default quantity for new proposals (used in calculation)
  const { getDefaultTradeQuantity } = await import('../core/config');
  const defaultQuantity = await getDefaultTradeQuantity(env);
  
  // Compute existing portfolio net premium
  // NOTE: This calculation assumes entry_price represents credit received for credit spreads.
  // For debit spreads, entry_price would represent debit paid, which should be subtracted, not added.
  // We identify debit spreads by checking if max_profit > max_loss (typical for debit spreads).
  let existingNetPremium = 0;
  for (const trade of openTrades) {
    if (trade.status !== 'OPEN' || !trade.entry_price || trade.entry_price <= 0) {
      continue; // Skip non-OPEN trades or trades without entry_price
    }
    
    // Identify debit spreads: for debit spreads, max_profit > max_loss (since max_profit = width - debit, max_loss = debit)
    // For credit spreads, max_profit < max_loss (since max_profit = credit, max_loss = width - credit)
    const isDebitTrade = trade.max_profit != null && trade.max_loss != null && trade.max_profit > trade.max_loss;
    
    if (isDebitTrade) {
      // For debit spreads, entry_price is the debit paid (positive value)
      // This reduces net premium, so we subtract it
      const quantity = trade.quantity ?? 1;
      const spreadNetDebit = trade.entry_price * 100 * quantity;
      existingNetPremium -= spreadNetDebit;
    } else {
      // For credit spreads, entry_price is the credit received (positive value)
      // This increases net premium, so we add it
      const quantity = trade.quantity ?? 1;
      const spreadNetPremium = trade.entry_price * 100 * quantity;
      existingNetPremium += spreadNetPremium;
    }
  }
  
  // Filter candidates that would keep portfolio net-credit
  // Note: This check only applies to credit spreads. Debit spreads are allowed even if they make portfolio net-debit.
  const filtered: ProposalCandidate[] = [];
  
  for (const candidate of candidates) {
    const isDebitSpread = candidate.strategy === 'BULL_CALL_DEBIT' || candidate.strategy === 'BEAR_PUT_DEBIT';
    
    // Skip portfolio net-credit check for debit spreads (they're supposed to have negative credits)
    if (isDebitSpread) {
      filtered.push(candidate);
      continue;
    }
    
    // For credit spreads, check that portfolio stays net-credit
    // For the new spread:
    // - Short put: we receive credit (candidate.credit)
    // - Long put: we pay cost (computed from spread)
    // Net premium = credit received per contract
    // Use default quantity for the new proposal (since ProposalCandidate doesn't have quantity yet)
    const newSpreadNetPremium = candidate.credit * 100 * defaultQuantity; // Convert to dollars (credit is per share, quantity is number of contracts)
    
    const portfolioNetPremiumAfter = existingNetPremium + newSpreadNetPremium;
    
    if (portfolioNetPremiumAfter >= 0) {
      filtered.push(candidate);
    } else {
      console.log('[proposals] portfolio_net_debit_rejected', JSON.stringify({
        symbol: candidate.symbol,
        expiration: candidate.expiration,
        short_strike: candidate.short_strike,
        long_strike: candidate.long_strike,
        credit: candidate.credit,
        existingNetPremium,
        newSpreadNetPremium,
        portfolioNetPremiumAfter,
      }));
    }
  }
  
  return filtered;
}


