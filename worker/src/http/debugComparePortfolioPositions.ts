/**
 * Debug endpoint to compare Tradier positions with our portfolio_positions table
 * Identifies discrepancies between Tradier and our mirror
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getAllPortfolioPositions } from '../db/queries';
import { parseOptionSymbol } from '../engine/portfolioSync';

export async function handleDebugComparePortfolioPositions(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const broker = new TradierClient(env);
    
    // Get Tradier positions
    const tradierPositions = await broker.getPositions();
    
    // Get our portfolio positions
    const ourPositions = await getAllPortfolioPositions(env);
    
    // Parse Tradier positions for comparison
    const tradierParsed = tradierPositions
      .map(pos => {
        const parsed = parseOptionSymbol(pos.symbol);
        if (!parsed) return null;
        const side: 'long' | 'short' = pos.quantity > 0 ? 'long' : 'short';
        return {
          symbol: pos.symbol,
          underlying: parsed.underlying,
          expiration: parsed.expiration,
          option_type: parsed.type,
          strike: parsed.strike,
          side,
          quantity: Math.abs(pos.quantity),
          cost_basis: pos.cost_basis,
        };
      })
      .filter(p => p !== null);
    
    // Create comparison keys
    const tradierKeys = new Set(
      tradierParsed.map(p => 
        `${p!.underlying}:${p!.expiration}:${p!.option_type}:${p!.strike}:${p!.side}`
      )
    );
    
    const ourKeys = new Set(
      ourPositions.map(p => 
        `${p.symbol}:${p.expiration}:${p.option_type}:${p.strike}:${p.side}`
      )
    );
    
    // Find differences
    const inTradierNotInOurs = tradierParsed.filter(p => {
      const key = `${p!.underlying}:${p!.expiration}:${p!.option_type}:${p!.strike}:${p!.side}`;
      return !ourKeys.has(key);
    });
    
    const inOursNotInTradier = ourPositions.filter(p => {
      const key = `${p.symbol}:${p.expiration}:${p.option_type}:${p.strike}:${p.side}`;
      return !tradierKeys.has(key);
    });
    
    return new Response(
      JSON.stringify({
        summary: {
          tradier_count: tradierPositions.length,
          tradier_parsed_count: tradierParsed.length,
          our_count: ourPositions.length,
          mismatch: ourPositions.length - tradierParsed.length,
        },
        tradier_positions: tradierParsed,
        our_positions: ourPositions,
        discrepancies: {
          in_tradier_not_in_ours: inTradierNotInOurs,
          in_ours_not_in_tradier: inOursNotInTradier,
        },
        warnings: [
          ...(inTradierNotInOurs.length > 0 ? [
            `Found ${inTradierNotInOurs.length} positions in Tradier that are NOT in our DB - sync may be missing them`
          ] : []),
          ...(inOursNotInTradier.length > 0 ? [
            `Found ${inOursNotInTradier.length} positions in our DB that are NOT in Tradier - these may be stale`
          ] : []),
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
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

