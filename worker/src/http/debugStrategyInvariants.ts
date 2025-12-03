/**
 * Debug endpoint to audit strategy invariants across all trades
 * 
 * This endpoint checks that all trades in the database conform to
 * the strategy + strike/leg invariants defined in core/strategyInvariants.ts
 */

import type { Env } from '../env';
import { getAllTrades } from '../db/queries';
import { checkStrategyInvariants } from '../core/strategyInvariants';

export async function handleDebugStrategyInvariants(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    // Load all trades (or at least all non-CLOSED + recent CLOSED)
    // For now, load all trades to get comprehensive audit (limit to 1000 to avoid memory issues)
    const allTrades = await getAllTrades(env, 1000);
    
    const violations: Array<{
      id: string;
      strategy: string | null;
      symbol: string;
      expiration: string;
      short_strike: number;
      long_strike: number;
      width: number;
      violations: string[];
    }> = [];
    
    const violationsByType: Record<string, number> = {};
    let totalChecked = 0;
    
    for (const trade of allTrades) {
      totalChecked++;
      const result = checkStrategyInvariants(trade);
      
      if (!result.ok) {
        violations.push({
          id: trade.id,
          strategy: trade.strategy || null,
          symbol: trade.symbol,
          expiration: trade.expiration,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          width: trade.width,
          violations: result.violations,
        });
        
        // Count violations by type
        for (const violation of result.violations) {
          const violationType = violation.split(':')[0] || violation;
          violationsByType[violationType] = (violationsByType[violationType] || 0) + 1;
        }
      }
    }
    
    // Limit to 50 examples for response size
    const exampleViolations = violations.slice(0, 50);
    
    const summary = {
      success: true,
      timestamp: now.toISOString(),
      total_trades_checked: totalChecked,
      total_violations: violations.length,
      violations_by_type: violationsByType,
      example_violations: exampleViolations,
      note: violations.length > 50 
        ? `Showing first 50 of ${violations.length} violations. All violations logged to console.`
        : 'All violations shown above.',
    };
    
    // Log summary with [strategy][invariants] prefix
    console.log('[strategy][invariants]', JSON.stringify({
      total_checked: totalChecked,
      total_violations: violations.length,
      violations_by_type: violationsByType,
      example_count: exampleViolations.length,
    }));
    
    // Log each violation individually for easier debugging
    for (const violation of violations) {
      console.log('[strategy][invariants][violation]', JSON.stringify(violation));
    }
    
    return new Response(
      JSON.stringify(summary, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        timestamp: now.toISOString(),
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

