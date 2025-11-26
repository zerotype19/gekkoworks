/**
 * Admin Repair Portfolio Endpoint
 * 
 * Manual "panic button" to repair portfolio structure.
 * Calls the same repairPortfolio() function used in monitor cycle.
 */

import type { Env } from '../env';
import { repairPortfolio } from '../engine/monitoring';
import { getOpenTrades } from '../db/queries';

export async function handleAdminRepairPortfolio(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    // Get open trades before repair
    const openTradesBefore = await getOpenTrades(env);
    
    // Run repair
    await repairPortfolio(env, now);
    
    // Get open trades after repair
    const openTradesAfter = await getOpenTrades(env);
    
    // Count how many were repaired (closed due to structural break)
    const repairedCount = openTradesBefore.length - openTradesAfter.length;
    
    return new Response(
      JSON.stringify({
        success: true,
        timestamp: now.toISOString(),
        summary: {
          spreadsChecked: openTradesBefore.length,
          spreadsRepaired: repairedCount,
          spreadsRemaining: openTradesAfter.length,
        },
        before: {
          totalOpen: openTradesBefore.length,
        },
        after: {
          totalOpen: openTradesAfter.length,
        },
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

