/**
 * Debug endpoint: /debug/regime-confidence
 * 
 * Returns regime confidence metric and trading recommendation.
 * 
 * regime_confidence = |price - SMA_20| / price
 * 
 * High confidence (> 0.004): Clear directional bias, trading allowed
 * Low confidence (< 0.004): Uncertain/chop, trading should be paused
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { detectRegime } from '../core/regime';
import { computeSMA20 } from '../core/trend';
import { MIN_REGIME_CONFIDENCE_THRESHOLD } from '../core/regimeConfidence';

const MIN_REGIME_CONFIDENCE = MIN_REGIME_CONFIDENCE_THRESHOLD;

export async function handleDebugRegimeConfidence(env: Env): Promise<Response> {
  try {
    const broker = new TradierClient(env);
    const symbol = 'SPY';
    
    // Get current price
    const underlying = await broker.getUnderlyingQuote(symbol);
    const currentPrice = underlying.last;
    
    // Get SMA_20
    const sma20 = await computeSMA20(env, symbol);
    
    // Detect regime
    const regimeState = await detectRegime(env, symbol, currentPrice);
    
    // Calculate regime confidence
    let regimeConfidence: number | null = null;
    let confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' = 'UNKNOWN';
    let tradingRecommended: boolean = false;
    let recommendationReason: string = '';
    
    if (sma20 !== null && currentPrice > 0) {
      const priceDiff = Math.abs(currentPrice - sma20);
      regimeConfidence = priceDiff / currentPrice;
      
      if (regimeConfidence >= MIN_REGIME_CONFIDENCE) {
        confidenceLevel = 'HIGH';
        tradingRecommended = true;
        recommendationReason = `Regime confidence (${(regimeConfidence * 100).toFixed(2)}%) exceeds minimum threshold (${(MIN_REGIME_CONFIDENCE * 100).toFixed(2)}%)`;
      } else if (regimeConfidence >= MIN_REGIME_CONFIDENCE * 0.5) {
        confidenceLevel = 'MEDIUM';
        tradingRecommended = false;
        recommendationReason = `Regime confidence (${(regimeConfidence * 100).toFixed(2)}%) is below minimum threshold (${(MIN_REGIME_CONFIDENCE * 100).toFixed(2)}%) - market may be choppy`;
      } else {
        confidenceLevel = 'LOW';
        tradingRecommended = false;
        recommendationReason = `Regime confidence (${(regimeConfidence * 100).toFixed(2)}%) is very low - price is too close to SMA_20, suggesting uncertain/chop conditions`;
      }
    } else {
      recommendationReason = 'SMA_20 not available - cannot compute regime confidence';
    }
    
    const response = {
      symbol,
      price: currentPrice,
      sma20,
      regime: regimeState.regime,
      regime_confidence: regimeConfidence,
      confidence_percent: regimeConfidence !== null ? (regimeConfidence * 100).toFixed(3) : null,
      confidence_level: confidenceLevel,
      min_confidence_threshold: MIN_REGIME_CONFIDENCE,
      min_confidence_percent: (MIN_REGIME_CONFIDENCE * 100).toFixed(2),
      trading_recommended: tradingRecommended,
      recommendation_reason: recommendationReason,
      price_vs_sma20: sma20 !== null ? {
        difference: currentPrice - sma20,
        difference_percent: ((currentPrice - sma20) / sma20 * 100).toFixed(2),
      } : null,
      timestamp: new Date().toISOString(),
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[debug][regime-confidence][error]', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// Re-export from core module for backward compatibility
export { isRegimeConfidenceSufficient } from '../core/regimeConfidence';

