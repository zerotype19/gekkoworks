/**
 * Debug endpoint to manually clean up stale portfolio positions
 * Deletes positions that exist in our DB but not in Tradier
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getAllPortfolioPositions, deletePortfolioPositionsNotInSet } from '../db/queries';
import { parseOptionSymbol } from '../engine/portfolioSync';
import { syncPortfolioFromTradier } from '../engine/portfolioSync';

export async function handleDebugCleanupStalePositions(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // First, run a full portfolio sync to ensure we're up to date
    const syncResult = await syncPortfolioFromTradier(env);
    
    // Then compare again
    const broker = new TradierClient(env);
    const tradierPositions = await broker.getPositions();
    const ourPositions = await getAllPortfolioPositions(env);
    
    // Parse Tradier positions for comparison
    const tradierParsed = tradierPositions
      .map(pos => {
        const parsed = parseOptionSymbol(pos.symbol);
        if (!parsed) return null;
        const side: 'long' | 'short' = pos.quantity > 0 ? 'long' : 'short';
        return {
          symbol: parsed.underlying,
          expiration: parsed.expiration,
          option_type: parsed.type,
          strike: parsed.strike,
          side,
        };
      })
      .filter(p => p !== null) as Array<{
      symbol: string;
      expiration: string;
      option_type: 'call' | 'put';
      strike: number;
      side: 'long' | 'short';
    }>;
    
    // Create comparison keys
    const tradierKeys = new Set(
      tradierParsed.map(p => 
        `${p.symbol}:${p.expiration}:${p.option_type}:${p.strike}:${p.side}`
      )
    );
    
    const ourKeys = new Set(
      ourPositions.map(p => 
        `${p.symbol}:${p.expiration}:${p.option_type}:${p.strike}:${p.side}`
      )
    );
    
    // Find stale positions (in our DB but not in Tradier)
    const stalePositions = ourPositions.filter(p => {
      const key = `${p.symbol}:${p.expiration}:${p.option_type}:${p.strike}:${p.side}`;
      return !tradierKeys.has(key);
    });
    
    // Delete stale positions
    let deletedCount = 0;
    if (stalePositions.length > 0) {
      // Re-run sync which should delete them
      deletedCount = await deletePortfolioPositionsNotInSet(env, tradierParsed);
    }
    
    // Get final count after cleanup
    const finalPositions = await getAllPortfolioPositions(env);
    
    return new Response(
      JSON.stringify({
        success: true,
        before: {
          tradier_count: tradierPositions.length,
          our_count: ourPositions.length,
          stale_count: stalePositions.length,
        },
        after: {
          our_count: finalPositions.length,
          deleted_count: deletedCount,
        },
        sync_result: {
          success: syncResult.success,
          synced: syncResult.synced,
          errors: syncResult.errors,
        },
        stale_positions: stalePositions.map(p => ({
          id: p.id,
          symbol: p.symbol,
          expiration: p.expiration,
          option_type: p.option_type,
          strike: p.strike,
          side: p.side,
          quantity: p.quantity,
          updated_at: p.updated_at,
        })),
        message: stalePositions.length > 0 
          ? `Found and cleaned up ${stalePositions.length} stale positions. ${deletedCount} positions deleted.`
          : 'No stale positions found - portfolio is in sync.',
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

