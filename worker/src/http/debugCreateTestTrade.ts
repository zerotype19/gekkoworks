/**
 * Debug Endpoint: Create Test Trade
 * 
 * POST /debug/create-test-trade
 * 
 * Creates a test OPEN trade for testing exit functionality.
 * Only works in SANDBOX_PAPER or DRY_RUN mode.
 */

import type { Env } from '../env';
import { insertTrade } from '../db/queries';
import { getTradingMode } from '../core/config';

export async function handleDebugCreateTestTrade(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const tradingMode = await getTradingMode(env);
    
    // Only allow in SANDBOX_PAPER or DRY_RUN
    if (tradingMode === 'LIVE') {
      return new Response(
        JSON.stringify({ error: 'This endpoint is disabled in LIVE mode' }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    const now = new Date();
    
    // Create a test trade (SPY put spread, 30-35 DTE)
    const expiration = new Date(now);
    expiration.setDate(expiration.getDate() + 32); // ~32 days out
    
    // Find nearest Friday
    const dayOfWeek = expiration.getDay();
    const daysToFriday = (5 - dayOfWeek + 7) % 7;
    if (daysToFriday > 0) {
      expiration.setDate(expiration.getDate() + daysToFriday);
    }
    
    const expirationStr = expiration.toISOString().split('T')[0];
    
    // Create a realistic test trade
    const testTrade = await insertTrade(env, {
      id: crypto.randomUUID(),
      proposal_id: null,
      symbol: 'SPY',
      expiration: expirationStr,
      short_strike: 640,
      long_strike: 635,
      width: 5,
      quantity: 1,
      entry_price: 1.00, // $1.00 credit
      exit_price: null,
      max_profit: 1.00,
      max_loss: 4.00,
      status: 'OPEN',
      exit_reason: null,
      broker_order_id_open: tradingMode === 'DRY_RUN' ? null : `TEST-${Date.now()}`,
      broker_order_id_close: null,
      opened_at: now.toISOString(),
      closed_at: null,
      realized_pnl: null,
      max_seen_profit_fraction: null,
    });
    
    console.log('[debug][create-test-trade]', JSON.stringify({
      trade_id: testTrade.id,
      symbol: testTrade.symbol,
      expiration: testTrade.expiration,
      entry_price: testTrade.entry_price,
      status: testTrade.status,
      trading_mode: tradingMode,
      timestamp: now.toISOString(),
    }));
    
    return new Response(
      JSON.stringify({
        success: true,
        trade: {
          id: testTrade.id,
          symbol: testTrade.symbol,
          expiration: testTrade.expiration,
          short_strike: testTrade.short_strike,
          long_strike: testTrade.long_strike,
          entry_price: testTrade.entry_price,
          status: testTrade.status,
        },
        trading_mode: tradingMode,
        timestamp: now.toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[debug][create-test-trade][error]', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
    
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

