/**
 * Debug endpoint to fix trades with incorrect strategies
 * 
 * Matches trades to their proposals and updates strategy if mismatched.
 * Strategy should be immutable, but this fixes historical data issues.
 */

import type { Env } from '../env';
import { getAllTrades, getProposal } from '../db/queries';
import { getDB } from '../db/client';

export async function handleDebugFixTradeStrategies(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dry_run') !== 'false'; // Default to dry run
    
    // Get all trades
    const allTrades = await getAllTrades(env, 1000);
    
    const results: Array<{
      tradeId: string;
      proposalId: string | null;
      currentStrategy: string | null;
      correctStrategy: string | null;
      fixed: boolean;
      error?: string;
    }> = [];
    
    let fixedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    for (const trade of allTrades) {
      const result: typeof results[0] = {
        tradeId: trade.id,
        proposalId: trade.proposal_id,
        currentStrategy: trade.strategy || null,
        correctStrategy: null,
        fixed: false,
      };
      
      // Only fix trades with proposal_id
      if (!trade.proposal_id) {
        result.error = 'No proposal_id - cannot determine correct strategy';
        skippedCount++;
        results.push(result);
        continue;
      }
      
      // Get proposal to find correct strategy
      const proposal = await getProposal(env, trade.proposal_id);
      if (!proposal) {
        result.error = 'Proposal not found';
        errorCount++;
        results.push(result);
        continue;
      }
      
      result.correctStrategy = proposal.strategy || null;
      
      // Check if strategy matches
      const currentStrategy = trade.strategy || 'BULL_PUT_CREDIT';
      const correctStrategy = proposal.strategy || 'BULL_PUT_CREDIT';
      
      if (currentStrategy === correctStrategy) {
        result.error = 'Strategy already correct';
        skippedCount++;
        results.push(result);
        continue;
      }
      
      // Fix the strategy (use raw SQL to bypass updateTrade safeguard)
      if (!dryRun) {
        try {
          const db = getDB(env);
          await db.prepare(`
            UPDATE trades 
            SET strategy = ?, updated_at = ?
            WHERE id = ?
          `).bind(correctStrategy, new Date().toISOString(), trade.id).run();
          
          result.fixed = true;
          fixedCount++;
          console.log('[debugFixTradeStrategies] fixed', JSON.stringify({
            tradeId: trade.id,
            proposalId: trade.proposal_id,
            oldStrategy: currentStrategy,
            newStrategy: correctStrategy,
          }));
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
          errorCount++;
        }
      } else {
        result.fixed = false; // Would be fixed in real run
        fixedCount++;
      }
      
      results.push(result);
    }
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        dryRun,
        summary: {
          total: allTrades.length,
          fixed: fixedCount,
          errors: errorCount,
          skipped: skippedCount,
        },
        results,
      }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
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

