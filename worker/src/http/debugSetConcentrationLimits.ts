/**
 * Debug endpoint: /debug/set-concentration-limits
 * 
 * Sets default concentration limit settings if they don't exist.
 * This ensures the concentration limits are active even if settings weren't manually configured.
 */

import type { Env } from '../env';
import { getSetting, setSetting } from '../db/queries';

export async function handleDebugSetConcentrationLimits(env: Env): Promise<Response> {
  try {
    const results: Record<string, { action: string; value: string }> = {};
    
    // Check and set MAX_SPREADS_PER_SYMBOL (default: 3)
    const maxSpreadsPerSymbol = await getSetting(env, 'MAX_SPREADS_PER_SYMBOL');
    if (!maxSpreadsPerSymbol) {
      await setSetting(env, 'MAX_SPREADS_PER_SYMBOL', '3');
      results.MAX_SPREADS_PER_SYMBOL = { action: 'set', value: '3' };
    } else {
      results.MAX_SPREADS_PER_SYMBOL = { action: 'already_set', value: maxSpreadsPerSymbol };
    }
    
    // Check and set MAX_QTY_PER_SYMBOL_PER_SIDE (default: 10)
    const maxQtyPerSymbolPerSide = await getSetting(env, 'MAX_QTY_PER_SYMBOL_PER_SIDE');
    if (!maxQtyPerSymbolPerSide) {
      await setSetting(env, 'MAX_QTY_PER_SYMBOL_PER_SIDE', '10');
      results.MAX_QTY_PER_SYMBOL_PER_SIDE = { action: 'set', value: '10' };
    } else {
      results.MAX_QTY_PER_SYMBOL_PER_SIDE = { action: 'already_set', value: maxQtyPerSymbolPerSide };
    }
    
    // Check and set MAX_QTY_PER_SPREAD (default: 10)
    const maxQtyPerSpread = await getSetting(env, 'MAX_QTY_PER_SPREAD');
    if (!maxQtyPerSpread) {
      await setSetting(env, 'MAX_QTY_PER_SPREAD', '10');
      results.MAX_QTY_PER_SPREAD = { action: 'set', value: '10' };
    } else {
      results.MAX_QTY_PER_SPREAD = { action: 'already_set', value: maxQtyPerSpread };
    }
    
    // Check and set MAX_TRADE_QUANTITY (default: 10)
    const maxTradeQuantity = await getSetting(env, 'MAX_TRADE_QUANTITY');
    if (!maxTradeQuantity) {
      await setSetting(env, 'MAX_TRADE_QUANTITY', '10');
      results.MAX_TRADE_QUANTITY = { action: 'set', value: '10' };
    } else {
      results.MAX_TRADE_QUANTITY = { action: 'already_set', value: maxTradeQuantity };
    }
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Concentration limit settings initialized',
      results,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

