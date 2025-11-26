/**
 * Debug Endpoint: Force Exit for a Specific Trade
 * 
 * POST /debug/force-exit/:tradeId
 * 
 * Bypasses exit rule logic and immediately triggers exit execution for a trade.
 * Useful for testing exit plumbing when markets are closed.
 */

import type { Env } from '../env';
import { getTrade } from '../db/queries';
import { executeExitForTrade } from '../engine/exits';
import type { MonitoringDecision, MonitoringMetrics } from '../types';

export async function handleDebugForceExit(
  request: Request,
  env: Env,
  tradeId: string
): Promise<Response> {
  try {
    const now = new Date();
    
    // Get the trade
    const trade = await getTrade(env, tradeId);
    if (!trade) {
      return new Response(
        JSON.stringify({ error: `Trade ${tradeId} not found` }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Check if trade is actually open
    if (trade.status !== 'OPEN') {
      return new Response(
        JSON.stringify({
          error: `Trade ${tradeId} is not OPEN (status: ${trade.status})`,
          current_status: trade.status,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Create a forced exit decision (bypasses normal exit rule evaluation)
    // Use EMERGENCY trigger to ensure it executes
    const forcedDecision: MonitoringDecision = {
      trigger: 'EMERGENCY',
      metrics: {
        current_mark: trade.entry_price || 0,
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
    
    console.log('[debug][force-exit]', JSON.stringify({
      trade_id: tradeId,
      symbol: trade.symbol,
      expiration: trade.expiration,
      entry_price: trade.entry_price,
      timestamp: now.toISOString(),
    }));
    
    // Execute the exit
    const exitResult = await executeExitForTrade(env, trade, forcedDecision, now);
    
    return new Response(
      JSON.stringify({
        success: exitResult.success,
        trade_id: tradeId,
        trigger: exitResult.trigger,
        reason: exitResult.reason,
        timestamp: now.toISOString(),
      }),
      {
        status: exitResult.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[debug][force-exit][error]', JSON.stringify({
      trade_id: tradeId,
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

