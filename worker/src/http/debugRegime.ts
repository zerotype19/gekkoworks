/**
 * Debug endpoint: /debug/regime
 * 
 * Returns current market regime state for visibility and verification.
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { detectRegime, getStrategiesForRegime } from '../core/regime';
import { getSetting } from '../db/queries';

export async function handleDebugRegime(env: Env): Promise<Response> {
  try {
    const broker = new TradierClient(env);
    const symbol = 'SPY'; // Primary symbol for regime detection
    
    // Get current price
    const underlying = await broker.getUnderlyingQuote(symbol);
    const currentPrice = underlying.last;
    
    // Detect regime
    const regimeState = await detectRegime(env, symbol, currentPrice);
    
    // Get previous regime from settings
    const previousRegimeKey = `REGIME_${symbol}`;
    const previousRegime = await getSetting(env, previousRegimeKey);
    
    // Get strategies enabled for this regime
    const { enabled, disabled } = getStrategiesForRegime(regimeState.regime);
    
    const response = {
      symbol,
      current_regime: regimeState.regime,
      price: currentPrice,
      sma20: regimeState.sma20,
      previous_regime: previousRegime || null,
      flipped: regimeState.flipped,
      last_flip_timestamp: regimeState.flipped ? regimeState.timestamp : null,
      strategies_enabled: enabled,
      strategies_disabled: disabled,
      timestamp: new Date().toISOString(),
    };
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[debug][regime][error]', error);
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

