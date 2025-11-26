/**
 * Debug Endpoint: Test Closing a Position Directly
 * 
 * POST /debug/test-close-position
 * 
 * Finds a random open PAPER position and attempts to close it directly via Tradier.
 * Tests the full exit → Tradier → DB pipeline.
 */

import type { Env } from '../env';
import { getOpenTrades } from '../db/queries';
import { TradierClient } from '../broker/tradierClient';
import { getTradingMode } from '../core/config';
import { executeExitForTrade } from '../engine/exits';
import type { MonitoringDecision } from '../types';

export async function handleDebugTestClosePosition(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const now = new Date();
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
    
    // Get all open trades
    const openTrades = await getOpenTrades(env);
    
    if (openTrades.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'No open trades found',
          suggestion: 'Open a trade first or use /debug/force-exit/:tradeId for a specific trade',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Find the first OPEN trade (not pending)
    const openTrade = openTrades.find(t => t.status === 'OPEN');
    
    if (!openTrade) {
      return new Response(
        JSON.stringify({
          error: 'No OPEN trades found (only pending trades exist)',
          open_trades: openTrades.map(t => ({
            id: t.id,
            status: t.status,
            symbol: t.symbol,
          })),
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    console.log('[debug][test-close-position]', JSON.stringify({
      trade_id: openTrade.id,
      symbol: openTrade.symbol,
      expiration: openTrade.expiration,
      entry_price: openTrade.entry_price,
      timestamp: now.toISOString(),
    }));
    
    // Get current quotes to build a realistic exit decision
    const broker = new TradierClient(env);
    let exitDecision: MonitoringDecision;
    
    try {
      // Try to get real quotes
      const underlying = await broker.getUnderlyingQuote(openTrade.symbol);
      const optionChain = await broker.getOptionChain(openTrade.symbol, openTrade.expiration);
      
      const shortPut = optionChain.find(
        opt => opt.strike === openTrade.short_strike && opt.type === 'put'
      );
      const longPut = optionChain.find(
        opt => opt.strike === openTrade.long_strike && opt.type === 'put'
      );
      
      if (shortPut && longPut && shortPut.bid && shortPut.ask && longPut.bid && longPut.ask) {
        // Use real quotes
        const markShort = (shortPut.bid + shortPut.ask) / 2;
        const markLong = (longPut.bid + longPut.ask) / 2;
        const currentMark = markShort - markLong;
        
        exitDecision = {
          trigger: 'EMERGENCY', // Force exit
          metrics: {
            current_mark: currentMark,
            unrealized_pnl: (openTrade.entry_price || 0) - currentMark,
            pnl_fraction: 0,
            loss_fraction: 0,
            dte: 0,
            underlying_price: underlying.last,
            underlying_change_1m: 0,
            underlying_change_15s: 0,
            liquidity_ok: true,
            quote_integrity_ok: true,
          },
        };
      } else {
        throw new Error('Missing option quotes');
      }
    } catch (error) {
      // Fallback to emergency exit with placeholder metrics
      console.warn('[debug][test-close-position] using fallback metrics', JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
      
      exitDecision = {
        trigger: 'EMERGENCY',
        metrics: {
          current_mark: openTrade.entry_price || 0,
          unrealized_pnl: 0,
          pnl_fraction: 0,
          loss_fraction: 0,
          dte: 0,
          underlying_price: 0,
          underlying_change_1m: 0,
          underlying_change_15s: 0,
          liquidity_ok: true,
          quote_integrity_ok: true,
        },
      };
    }
    
    // Execute the exit
    const exitResult = await executeExitForTrade(env, openTrade, exitDecision, now);
    
    return new Response(
      JSON.stringify({
        success: exitResult.success,
        trade_id: openTrade.id,
        symbol: openTrade.symbol,
        expiration: openTrade.expiration,
        trigger: exitResult.trigger,
        reason: exitResult.reason,
        trading_mode: tradingMode,
        timestamp: now.toISOString(),
      }),
      {
        status: exitResult.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[debug][test-close-position][error]', JSON.stringify({
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

