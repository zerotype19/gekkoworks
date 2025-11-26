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
    
    for (const pos of positions) {
      const parsed = parseOptionSymbol(pos.symbol);
      if (!parsed || parsed.type !== 'put') continue;
      
      // For each position, we need to find matching trades
      // We'll match by expiration and strike
      const key = `${parsed.expiration}-${parsed.strike}`;
      const absQty = Math.abs(pos.quantity);
      
      // Store the max quantity we see for this strike/expiration
      const existing = positionMap.get(key);
      if (!existing || absQty > existing) {
        positionMap.set(key, absQty);
      }
    }
    
    // 4. Group positions into spreads to get actual quantities
    const spreads: Array<{
      symbol: string;
      expiration: string;
      short_strike: number;
      long_strike: number;
      quantity: number;
    }> = [];
    
    // Group by expiration
    const byExpiration = new Map<string, typeof positions>();
    for (const pos of positions) {
      const parsed = parseOptionSymbol(pos.symbol);
      if (!parsed || parsed.type !== 'put') continue;
      
      if (!byExpiration.has(parsed.expiration)) {
        byExpiration.set(parsed.expiration, []);
      }
      byExpiration.get(parsed.expiration)!.push(pos);
    }
    
    // Find matching spreads
    for (const [expiration, expPositions] of byExpiration.entries()) {
      const shortPuts = expPositions.filter(p => {
        const parsed = parseOptionSymbol(p.symbol);
        return parsed && parsed.type === 'put' && p.quantity < 0;
      });
      
      const longPuts = expPositions.filter(p => {
        const parsed = parseOptionSymbol(p.symbol);
        return parsed && parsed.type === 'put' && p.quantity > 0;
      });
      
      for (const shortPut of shortPuts) {
        const shortParsed = parseOptionSymbol(shortPut.symbol);
        if (!shortParsed) continue;
        
        for (const longPut of longPuts) {
          const longParsed = parseOptionSymbol(longPut.symbol);
          if (!longParsed) continue;
          
          const width = shortParsed.strike - longParsed.strike;
          if (width === 5 && Math.abs(shortPut.quantity) === longPut.quantity) {
            spreads.push({
              symbol: shortParsed.underlying,
              expiration,
              short_strike: shortParsed.strike,
              long_strike: longParsed.strike,
              quantity: Math.abs(shortPut.quantity),
            });
          }
        }
      }
    }
    
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
        if (currentQuantity !== matchingSpread.quantity) {
          await updateTrade(env, trade.id, { quantity: matchingSpread.quantity });
          updates.push({
            tradeId: trade.id,
            oldQuantity: currentQuantity,
            newQuantity: matchingSpread.quantity,
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
          quantity: s.quantity,
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

