/**
 * Debug endpoint to clean up price snap entries from settings table
 * 
 * GET /debug/cleanup-price-snaps - Shows count of price snap entries
 * POST /debug/cleanup-price-snaps - Cleans up price snap entries
 *   body: { tradeId?: string } - Optional trade ID to clean up specific trade, or omit to clean all
 */

import type { Env } from '../env';
import { cleanupPriceSnaps, countPriceSnaps } from '../db/queries';

export async function handleDebugCleanupPriceSnaps(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    if (request.method === 'GET') {
      // Show count of price snap entries
      const count = await countPriceSnaps(env);
      return new Response(
        JSON.stringify({
          success: true,
          price_snap_count: count,
          message: `Found ${count} price snap entries in settings table`,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else if (request.method === 'POST') {
      // Clean up price snap entries
      const body = await request.json().catch(() => ({})) as { tradeId?: string };
      const { tradeId } = body;
      
      const deleted = await cleanupPriceSnaps(env, tradeId);
      
      return new Response(
        JSON.stringify({
          success: true,
          deleted_count: deleted,
          trade_id: tradeId || 'all',
          message: `Deleted ${deleted} price snap entries${tradeId ? ` for trade ${tradeId}` : ' (all trades)'}`,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
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

