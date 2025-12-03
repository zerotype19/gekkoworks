/**
 * Portfolio Positions Endpoint
 * 
 * Read-only endpoint to get current portfolio positions from the portfolio_positions table.
 * This is a pure mirror of Tradier positions (one row per leg).
 */

import type { Env } from '../env';
import { getAllPortfolioPositions } from '../db/queries';

export async function handlePortfolioPositions(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const positions = await getAllPortfolioPositions(env);
    
    // Group by symbol for easier UI display
    const positionsBySymbol = new Map<string, typeof positions>();
    for (const pos of positions) {
      if (!positionsBySymbol.has(pos.symbol)) {
        positionsBySymbol.set(pos.symbol, []);
      }
      positionsBySymbol.get(pos.symbol)!.push(pos);
    }
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        total: positions.length,
        positions: positions.map(p => ({
          id: p.id,
          symbol: p.symbol,
          expiration: p.expiration,
          option_type: p.option_type,
          strike: p.strike,
          side: p.side,
          quantity: p.quantity,
          cost_basis_per_contract: p.cost_basis_per_contract,
          last_price: p.last_price,
          bid: p.bid,
          ask: p.ask,
          updated_at: p.updated_at,
        })),
        bySymbol: Object.fromEntries(
          Array.from(positionsBySymbol.entries()).map(([symbol, pos]) => [
            symbol,
            pos.map(p => ({
              id: p.id,
              expiration: p.expiration,
              option_type: p.option_type,
              strike: p.strike,
              side: p.side,
              quantity: p.quantity,
              cost_basis_per_contract: p.cost_basis_per_contract,
              last_price: p.last_price,
              bid: p.bid,
              ask: p.ask,
              updated_at: p.updated_at,
            })),
          ])
        ),
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

