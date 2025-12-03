/**
 * Debug endpoint to force a portfolio sync and show what was deleted
 */

import type { Env } from '../env';
import { getAllPortfolioPositions } from '../db/queries';
import { syncPortfolioFromTradier } from '../engine/portfolioSync';

export async function handleDebugForcePortfolioSync(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Get positions before sync
    const positionsBefore = await getAllPortfolioPositions(env);
    
    // Run portfolio sync
    const syncResult = await syncPortfolioFromTradier(env);
    
    // Get positions after sync
    const positionsAfter = await getAllPortfolioPositions(env);
    
    return new Response(
      JSON.stringify({
        success: syncResult.success,
        before: {
          position_count: positionsBefore.length,
        },
        after: {
          position_count: positionsAfter.length,
        },
        sync_result: {
          synced: syncResult.synced,
          errors: syncResult.errors,
        },
        deleted_count: positionsBefore.length - positionsAfter.length,
        message: syncResult.success
          ? `Portfolio sync completed. ${positionsBefore.length - positionsAfter.length} positions deleted, ${syncResult.synced} positions synced.`
          : `Portfolio sync failed: ${syncResult.errors.join(', ')}`,
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

