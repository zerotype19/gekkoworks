/**
 * Debug endpoint to inspect exit order payload for a trade
 * 
 * GET /debug/exit/:tradeId
 * 
 * Returns the exit order payload that would be built for a trade,
 * including positions from portfolio_positions and the payload structure.
 */

import type { Env } from '../env';
import { getTrade } from '../db/queries';
import { getOpenPositionsForTrade } from '../portfolio/getOpenPositionsForTrade';
import { buildExitOrderPayload } from '../tradier/buildExitOrderPayload';

export async function handleDebugExitPayload(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const tradeId = pathParts[pathParts.length - 1];
    
    if (!tradeId) {
      return new Response(
        JSON.stringify({
          error: 'Trade ID required',
          path: url.pathname,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Get trade
    const trade = await getTrade(env, tradeId);
    if (!trade) {
      return new Response(
        JSON.stringify({
          error: 'Trade not found',
          trade_id: tradeId,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Get positions from portfolio_positions
    const positions = await getOpenPositionsForTrade(env, trade);
    
    // Build exit order payload
    const payload = await buildExitOrderPayload(trade, positions);
    
    return new Response(
      JSON.stringify({
        trade: {
          id: trade.id,
          symbol: trade.symbol,
          expiration: trade.expiration,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          strategy: trade.strategy,
          quantity: trade.quantity,
          status: trade.status,
          entry_price: trade.entry_price,
          exit_price: trade.exit_price,
          exit_reason: trade.exit_reason,
        },
        positions: positions.map(p => ({
          strike: p.strike,
          side: p.side,
          quantity: p.quantity,
          option_type: p.option_type,
          cost_basis_per_contract: p.cost_basis_per_contract,
          last_price: p.last_price,
          bid: p.bid,
          ask: p.ask,
        })),
        payload: payload,
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
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

