/**
 * Debug Portfolio Sync Endpoint
 * 
 * Tests the portfolio sync logic and shows detailed information about:
 * - Raw positions from Tradier
 * - Parsed positions
 * - Grouped spreads
 * - Matching trades in DB
 * - What would be created
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getOpenTrades } from '../db/queries';
import { syncPortfolioFromTradier } from '../engine/portfolioSync';

export async function handleDebugPortfolioSync(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    const broker = new TradierClient(env);
    
    // 1. Fetch raw positions from Tradier
    const positions = await broker.getPositions();
    
    // 2. Get our open trades
    const ourTrades = await getOpenTrades(env);
    
    // 3. Run the actual sync to see what happens
    const syncResult = await syncPortfolioFromTradier(env);
    
    // 4. Get trades again after sync
    const tradesAfterSync = await getOpenTrades(env);
    
    // 5. Group positions by expiration and strike for analysis
    const positionsByExpiration = new Map<string, typeof positions>();
    for (const pos of positions) {
      // Extract expiration from symbol (e.g., SPY251212P00630000 -> 2025-12-12)
      const match = pos.symbol.match(/^[A-Z]+(\d{6})/);
      if (match) {
        const dateStr = match[1];
        const year = 2000 + parseInt(dateStr.substring(0, 2));
        const month = dateStr.substring(2, 4);
        const day = dateStr.substring(4, 6);
        const expiration = `${year}-${month}-${day}`;
        
        if (!positionsByExpiration.has(expiration)) {
          positionsByExpiration.set(expiration, []);
        }
        positionsByExpiration.get(expiration)!.push(pos);
      }
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        timestamp: now.toISOString(),
        summary: {
          tradierPositions: positions.length,
          tradesBeforeSync: ourTrades.length,
          tradesAfterSync: tradesAfterSync.length,
          syncResult: {
            synced: syncResult.synced,
            created: syncResult.created,
            errors: syncResult.errors.length,
          },
        },
        rawPositions: positions.map(p => ({
          symbol: p.symbol,
          quantity: p.quantity,
          cost_basis: p.cost_basis,
          market_value: p.market_value,
          gain_loss: p.gain_loss,
        })),
        positionsByExpiration: Object.fromEntries(
          Array.from(positionsByExpiration.entries()).map(([exp, pos]) => [
            exp,
            pos.map(p => ({
              symbol: p.symbol,
              quantity: p.quantity,
              cost_basis: p.cost_basis,
            })),
          ])
        ),
        ourTrades: ourTrades.map(t => ({
          id: t.id,
          symbol: t.symbol,
          expiration: t.expiration,
          short_strike: t.short_strike,
          long_strike: t.long_strike,
          quantity: t.quantity ?? 1,
          entry_price: t.entry_price,
          broker_order_id_open: t.broker_order_id_open,
          status: t.status,
        })),
        newTrades: tradesAfterSync
          .filter(t => !ourTrades.some(ot => ot.id === t.id))
          .map(t => ({
            id: t.id,
            symbol: t.symbol,
            expiration: t.expiration,
            short_strike: t.short_strike,
            long_strike: t.long_strike,
            quantity: t.quantity ?? 1,
            entry_price: t.entry_price,
            status: t.status,
          })),
        syncErrors: syncResult.errors,
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

