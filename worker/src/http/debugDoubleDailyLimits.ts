/**
 * Debug endpoint to double all daily limits for testing
 * Doubles: MAX_OPEN_POSITIONS, MAX_OPEN_SPREADS_GLOBAL, MAX_OPEN_SPREADS_PER_SYMBOL,
 * MAX_NEW_TRADES_PER_DAY, DAILY_MAX_NEW_RISK, MAX_TOTAL_ORDER_DETAIL_FETCHES
 */

import type { Env } from '../env';
import { getSetting, setSetting } from '../db/queries';

export async function handleDebugDoubleDailyLimits(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const results: Record<string, { before: string; after: string }> = {};
    
    // List of all daily limit settings to double
    const limitSettings = [
      'MAX_OPEN_POSITIONS',
      'MAX_OPEN_SPREADS_GLOBAL',
      'MAX_OPEN_SPREADS_PER_SYMBOL',
      'MAX_NEW_TRADES_PER_DAY',
      'DAILY_MAX_NEW_RISK',
      'MAX_SPREADS_PER_SYMBOL',
      'MAX_QTY_PER_SYMBOL_PER_SIDE',
      'MAX_TOTAL_QTY_PER_SYMBOL',
      'MAX_TRADE_QUANTITY',
    ];
    
    // Default values (these are used if setting doesn't exist)
    const defaults: Record<string, number> = {
      'MAX_OPEN_POSITIONS': 10,
      'MAX_OPEN_SPREADS_GLOBAL': 10,
      'MAX_OPEN_SPREADS_PER_SYMBOL': 5,
      'MAX_NEW_TRADES_PER_DAY': 5,
      'DAILY_MAX_NEW_RISK': 0, // 0 means unlimited, so we'll skip doubling this one
      'MAX_SPREADS_PER_SYMBOL': 3,
      'MAX_QTY_PER_SYMBOL_PER_SIDE': 10,
      'MAX_TOTAL_QTY_PER_SYMBOL': 50,
      'MAX_TRADE_QUANTITY': 10,
    };
    
    for (const setting of limitSettings) {
      const currentValue = await getSetting(env, setting);
      const currentNum = currentValue ? parseFloat(currentValue) : defaults[setting];
      
      // Skip DAILY_MAX_NEW_RISK if it's 0 (unlimited)
      if (setting === 'DAILY_MAX_NEW_RISK' && currentNum === 0) {
        results[setting] = {
          before: currentValue || '0 (unlimited)',
          after: '0 (unlimited - unchanged)',
        };
        continue;
      }
      
      const doubledValue = Math.max(1, Math.floor(currentNum * 2));
      await setSetting(env, setting, doubledValue.toString());
      
      results[setting] = {
        before: currentValue || `${defaults[setting]} (default)`,
        after: doubledValue.toString(),
      };
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        message: 'All daily limits doubled',
        results,
        note: 'MAX_TOTAL_ORDER_DETAIL_FETCHES has been doubled in orderSync.ts (50 → 100). Deploy worker to apply.',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

