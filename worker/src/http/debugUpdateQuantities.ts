/**
 * Debug Update Quantities Endpoint
 * 
 * Updates all existing trades with correct quantities from Tradier positions.
 * This should be run once after adding the quantity column.
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getOpenTrades, updateTrade } from '../db/queries';

/**
 * Parse option symbol to extract trade details
 */
function parseOptionSymbol(symbol: string): {
  underlying: string;
  expiration: string;
  type: 'put' | 'call';
  strike: number;
} | null {
  const match = symbol.match(/^([A-Z]+)(\d{6})([PC])(\d{8})$/);
  if (!match) {
    return null;
  }
  
  const [, underlying, dateStr, typeChar, strikeStr] = match;
  const type = typeChar === 'P' ? 'put' : 'call';
  
  const year = 2000 + parseInt(dateStr.substring(0, 2));
  const month = dateStr.substring(2, 4);
  const day = dateStr.substring(4, 6);
  const expiration = `${year}-${month}-${day}`;
  
  const strike = parseInt(strikeStr) / 1000;
  
  return { underlying, expiration, type, strike };
}

export async function handleDebugUpdateQuantities(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    const broker = new TradierClient(env);
    
    // 1. Fetch positions from Tradier
    const positions = await broker.getPositions();
    
    // 2. Get our open trades
    const openTrades = await getOpenTrades(env);
    
    // 3. Build a map of (symbol, expiration, short_strike, long_strike) -> quantity
    const positionMap = new Map<string, number>();
    
    // 4. Use groupPositionsIntoSpreads from portfolioSync (handles all strategy types)
    const { groupPositionsIntoSpreads } = await import('../engine/portfolioSync');
    const spreads = groupPositionsIntoSpreads(positions);
    
    // 5. Update trades with correct quantities
    const updates: Array<{ tradeId: string; oldQuantity: number; newQuantity: number }> = [];
    
    for (const trade of openTrades) {
      const matchingSpread = spreads.find(s =>
        s.symbol === trade.symbol &&
        s.expiration === trade.expiration &&
        s.short_strike === trade.short_strike &&
        s.long_strike === trade.long_strike
      );
      
      if (matchingSpread) {
        const currentQuantity = trade.quantity ?? 1;
        const spreadQuantity = matchingSpread.short_quantity; // Should equal long_quantity for valid spread
        if (currentQuantity !== spreadQuantity) {
          await updateTrade(env, trade.id, { quantity: spreadQuantity });
          updates.push({
            tradeId: trade.id,
            oldQuantity: currentQuantity,
            newQuantity: spreadQuantity,
          });
        }
      }
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        timestamp: now.toISOString(),
        summary: {
          tradierPositions: positions.length,
          spreadsFound: spreads.length,
          tradesChecked: openTrades.length,
          tradesUpdated: updates.length,
        },
        spreads: spreads.map(s => ({
          symbol: s.symbol,
          expiration: s.expiration,
          short_strike: s.short_strike,
          long_strike: s.long_strike,
          quantity: s.short_quantity, // Use short_quantity (should equal long_quantity)
        })),
        updates: updates,
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

