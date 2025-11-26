/**
 * SAS v1 Trades Endpoint
 * 
 * Read-only endpoints to list and view trades.
 * Per architecture.md and system-interfaces.md.
 */

import type { Env } from '../env';
import { getAllTrades, getTrade } from '../db/queries';

/**
 * Handle trades list request
 * 
 * Per system-interfaces.md:
 * export async function handleTrades(
 *   request: Request,
 *   env: Env,
 *   ctx: ExecutionContext
 * ): Promise<Response>;
 */
export async function handleTrades(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam) : 100;
    
    const trades = await getAllTrades(env, limit);
    
    console.log('[http] /trades endpoint', JSON.stringify({
      limit,
      tradeCount: trades.length,
      statuses: trades.map(t => t.status),
    }));
    
    return new Response(
      JSON.stringify({
        trades,
        count: trades.length,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('[http] /trades endpoint error', JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
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

/**
 * Handle trade detail request
 * 
 * Per system-interfaces.md:
 * export async function handleTradeDetail(
 *   request: Request,
 *   env: Env,
 *   ctx: ExecutionContext,
 *   tradeId: string
 * ): Promise<Response>;
 */
export async function handleTradeDetail(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  tradeId: string
): Promise<Response> {
  try {
    const trade = await getTrade(env, tradeId);
    
    if (!trade) {
      return new Response(
        JSON.stringify({
          error: 'Trade not found',
        }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }
    
    return new Response(
      JSON.stringify(trade),
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

