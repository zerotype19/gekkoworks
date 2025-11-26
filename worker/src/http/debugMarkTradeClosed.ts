/**
 * SAS v1 Manual Close Endpoint
 * 
 * Emergency endpoint to manually mark a trade as closed.
 * Only available in SANDBOX_PAPER mode.
 * Does NOT place any orders - just updates database state.
 */

import type { Env } from '../env';
import { getTrade, updateTrade } from '../db/queries';
import { markTradeClosed } from '../engine/lifecycle';
import { recordTradeClosed } from '../core/risk';
import { getTradingMode } from '../core/config';

/**
 * Handle manual close request
 * 
 * POST /debug/mark-trade-closed
 * Body: { tradeId: string, exit_reason?: string }
 */
export async function handleDebugMarkTradeClosed(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    // Only allow in SANDBOX_PAPER mode
    const tradingMode = await getTradingMode(env);
    if (tradingMode !== 'SANDBOX_PAPER') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Manual close only allowed in SANDBOX_PAPER mode',
          trading_mode: tradingMode,
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Method not allowed. Use POST.',
        }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const body = await request.json() as { tradeId: string; exit_reason?: string };
    const { tradeId, exit_reason } = body;

    if (!tradeId) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'tradeId is required',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Get the trade
    const trade = await getTrade(env, tradeId);
    if (!trade) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Trade ${tradeId} not found`,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Check if already closed
    if (trade.status === 'CLOSED') {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Trade is already closed',
          trade: {
            id: trade.id,
            status: trade.status,
            closed_at: trade.closed_at,
          },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Mark as closed with exit_price = 0 (manual close)
    const closedTrade = await markTradeClosed(
      env,
      tradeId,
      0, // exit_price = 0 for manual close
      new Date()
    );

    // Update exit_reason if provided
    if (exit_reason) {
      await updateTrade(env, tradeId, {
        exit_reason: exit_reason as any,
      });
    } else {
      await updateTrade(env, tradeId, {
        exit_reason: 'MANUAL_CLOSE',
      });
    }

    // Record in risk system
    await recordTradeClosed(env, closedTrade);

    return new Response(
      JSON.stringify({
        success: true,
        trade: {
          id: closedTrade.id,
          status: closedTrade.status,
          exit_reason: closedTrade.exit_reason,
          closed_at: closedTrade.closed_at,
        },
        message: 'Trade marked as closed (no orders placed)',
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

