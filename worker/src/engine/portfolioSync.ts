/**
 * Portfolio Sync Engine
 * 
 * Maintains real-time sync between Tradier positions and our database.
 * Ensures we monitor ALL open positions, not just ones we created.
 */

import type { Env } from '../env';
import type { BrokerPosition } from '../types';
import { TradierClient } from '../broker/tradierClient';
import { 
  upsertPortfolioPosition, 
  deletePortfolioPositionsNotInSet,
  getAllPortfolioPositions 
} from '../db/queries';
import { updatePositionsSyncTimestamp } from '../core/syncFreshness';

/**
 * Parse option symbol to extract trade details
 * Format: SPY251212P00645000 = SPY + YYMMDD + P/C + Strike (padded to 8 digits)
 * 
 * NOTE: This parser only handles standard OCC-style option symbols:
 * - Uppercase tickers only (no dots, no weeklies with extra letters)
 * - Standard YYMMDD expiration format
 * - Standard strike encoding (strike * 1000, padded to 8 digits)
 * 
 * ASSUMPTIONS:
 * - Underlying is variable length uppercase letters only (no length cap)
 * - Tradier uses pure OCC format (no '.' or '-' variants in underlying)
 * - All valid option positions will match this format
 * 
 * Will return null for:
 * - Weeklies with extra letters in underlying (e.g., SPYW)
 * - Index options with different vendor formats
 * - Any non-standard symbol encoding
 * - Equities (stocks, ETFs) - these are not options
 * 
 * CRITICAL: Any checks relying on parseOptionSymbol will never "see" positions
 * that don't match this format. They will be treated as "non-option" and skipped.
 */
export function parseOptionSymbol(symbol: string): {
  underlying: string;
  expiration: string;
  type: 'put' | 'call';
  strike: number;
} | null {
  // Match: SPY251212P00645000
  // SPY = underlying (variable length, uppercase only)
  // 251212 = YYMMDD (6 digits)
  // P/C = type (1 char)
  // 00645000 = strike * 1000, padded to 8 digits
  
  const match = symbol.match(/^([A-Z]+)(\d{6})([PC])(\d{8})$/);
  if (!match) {
    return null;
  }
  
  const [, underlying, dateStr, typeChar, strikeStr] = match;
  const type = typeChar === 'P' ? 'put' : 'call';
  
  // Parse date: YYMMDD -> YYYY-MM-DD
  const year = 2000 + parseInt(dateStr.substring(0, 2));
  const month = dateStr.substring(2, 4);
  const day = dateStr.substring(4, 6);
  const expiration = `${year}-${month}-${day}`;
  
  // Parse strike: 00645000 -> 645.00
  const strike = parseInt(strikeStr) / 1000;
  
  return { underlying, expiration, type, strike };
}

/**
 * Group positions into spreads
 * Supports all strategy types:
 * - Put spreads: BULL_PUT_CREDIT, BEAR_PUT_DEBIT
 * - Call spreads: BEAR_CALL_CREDIT, BULL_CALL_DEBIT
 * 
 * CRITICAL: This function is ONLY for standard 5-wide, 1:1 two-leg spreads.
 * Anything else (flies, diagonals, ratio spreads, broken pairs, partial hedges)
 * will be silently ignored and won't appear in the returned spreads array.
 * 
 * All spreads have 5-point width and matching quantities.
 * 
 * Returns quantities as absolute magnitudes (both positive), not signed values.
 */
export function groupPositionsIntoSpreads(positions: BrokerPosition[]): Array<{
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  short_quantity: number;
  long_quantity: number;
  short_cost_basis: number | null;
  long_cost_basis: number | null;
}> {
  const spreads: Array<{
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    short_quantity: number;
    long_quantity: number;
    short_cost_basis: number | null;
    long_cost_basis: number | null;
  }> = [];
  
    // Group by underlying, expiration, and option type (put/call)
    // This ensures we only consider spreads within the same underlying
    // and avoids cross-underlying pairs (e.g., SPY + QQQ) being considered
    const byUnderlyingExpirationAndType = new Map<string, BrokerPosition[]>();
  
  for (const pos of positions) {
    const parsed = parseOptionSymbol(pos.symbol);
    if (!parsed) {
      continue; // Skip non-option positions
    }
    
      // Group by underlying, expiration, and type (put or call)
    // Use '::' separator to avoid conflicts with expiration date format (YYYY-MM-DD)
      // This tightens the mental model: "per underlying + expiry + type"
      const key = `${parsed.underlying}::${parsed.expiration}::${parsed.type}`;
      if (!byUnderlyingExpirationAndType.has(key)) {
        byUnderlyingExpirationAndType.set(key, []);
      }
      byUnderlyingExpirationAndType.get(key)!.push(pos);
    }
  
  // For each underlying+expiration+type combination, find matching spreads
  for (const [key, expPositions] of byUnderlyingExpirationAndType.entries()) {
    const [underlying, expiration, optionType] = key.split('::');
    const isPut = optionType === 'put';
    
    // Find short positions (quantity < 0)
    const shortPositions = expPositions.filter(p => {
      const parsed = parseOptionSymbol(p.symbol);
      return parsed && parsed.type === optionType && p.quantity < 0;
    });
    
    // Find long positions (quantity > 0)
    const longPositions = expPositions.filter(p => {
      const parsed = parseOptionSymbol(p.symbol);
      return parsed && parsed.type === optionType && p.quantity > 0;
    });
    
    // Match short and long positions that form a 5-point spread
    // Use a Set to de-dup spreads by (underlying, expiration, short_strike, long_strike)
    const spreadKeys = new Set<string>();
    
    console.log('[portfolioSync][groupSpreads] processing expiration+type', JSON.stringify({
      key,
      expiration,
      optionType,
      shortPositionsCount: shortPositions.length,
      longPositionsCount: longPositions.length,
      shortPositions: shortPositions.map(p => {
        const parsed = parseOptionSymbol(p.symbol);
        return parsed ? { symbol: p.symbol, strike: parsed.strike, quantity: p.quantity } : null;
      }).filter(Boolean),
      longPositions: longPositions.map(p => {
        const parsed = parseOptionSymbol(p.symbol);
        return parsed ? { symbol: p.symbol, strike: parsed.strike, quantity: p.quantity } : null;
      }).filter(Boolean),
    }));
    
    for (const shortPos of shortPositions) {
      const shortParsed = parseOptionSymbol(shortPos.symbol);
      if (!shortParsed) continue;
      
      for (const longPos of longPositions) {
        const longParsed = parseOptionSymbol(longPos.symbol);
        if (!longParsed) continue;
        
        // NOTE: Both legs are already guaranteed to be from the same underlying
        // because we grouped by underlying::expiration::type above
        // This check is now redundant but kept for defensive programming
        
        // Check if they form a 5-point spread
        // For puts: short_strike > long_strike (e.g., short 285, long 280)
        // For calls: short_strike < long_strike (e.g., short 285, long 290) OR long_strike < short_strike (e.g., long 280, short 285 for BULL_CALL_DEBIT)
        // Width is always |short_strike - long_strike| = 5
        const width = Math.abs(shortParsed.strike - longParsed.strike);
        const quantityMatch = Math.abs(shortPos.quantity) === longPos.quantity;
        
        console.log('[portfolioSync][groupSpreads][checking-pair]', JSON.stringify({
          shortSymbol: shortPos.symbol,
          shortStrike: shortParsed.strike,
          shortQuantity: shortPos.quantity,
          longSymbol: longPos.symbol,
          longStrike: longParsed.strike,
          longQuantity: longPos.quantity,
          width,
          quantityMatch,
          wouldMatch: width === 5 && quantityMatch,
        }));
        
        if (width === 5 && quantityMatch) {
          // Create de-dup key to prevent double-counting the same spread
          // Use consistent ordering: always use lower strike first, higher strike second
          const lowerStrike = Math.min(shortParsed.strike, longParsed.strike);
          const higherStrike = Math.max(shortParsed.strike, longParsed.strike);
          const spreadKey = `${shortParsed.underlying}-${expiration}-${lowerStrike}-${higherStrike}`;
          if (spreadKeys.has(spreadKey)) {
            continue; // Already added this spread
          }
          spreadKeys.add(spreadKey);
          
        // Determine short_strike and long_strike based on option type and strike relationship
        // For puts: short_strike > long_strike (BULL_PUT_CREDIT: short 285, long 280)
        //           OR long_strike > short_strike (BEAR_PUT_DEBIT: long 285, short 280)
        // For calls: short_strike < long_strike (BEAR_CALL_CREDIT: short 285, long 290)
        //            OR long_strike < short_strike (BULL_CALL_DEBIT: long 280, short 285)
        // 
        // Strategy determination:
        // - BULL_PUT_CREDIT: puts, short_strike > long_strike
        // - BEAR_PUT_DEBIT: puts, long_strike > short_strike
        // - BEAR_CALL_CREDIT: calls, short_strike < long_strike
        // - BULL_CALL_DEBIT: calls, long_strike < short_strike
        //
        // Since positions have negative quantity for short and positive for long,
        // we can determine the relationship:
        let shortStrike: number;
        let longStrike: number;
        
        if (isPut) {
          // For puts: higher strike is typically the short leg (BULL_PUT_CREDIT)
          // But could be lower strike if it's BEAR_PUT_DEBIT
          // Use the strike with negative quantity as short, positive as long
          shortStrike = shortParsed.strike; // This is the one with negative quantity
          longStrike = longParsed.strike;   // This is the one with positive quantity
        } else {
          // For calls: lower strike is typically the long leg (BULL_CALL_DEBIT)
          // But could be higher strike if it's BEAR_CALL_CREDIT
          // Use the strike with negative quantity as short, positive as long
          shortStrike = shortParsed.strike; // This is the one with negative quantity
          longStrike = longParsed.strike;   // This is the one with positive quantity
        }
        
        console.log('[portfolioSync][groupSpreads][found-spread]', JSON.stringify({
          symbol: shortParsed.underlying,
          expiration,
          short_strike: shortStrike,
          long_strike: longStrike,
          short_quantity: Math.abs(shortPos.quantity),
          long_quantity: longPos.quantity,
          optionType,
        }));
        
        spreads.push({
          symbol: shortParsed.underlying,
          expiration,
          short_strike: shortStrike,
          long_strike: longStrike,
          // NOTE: Both quantities are absolute magnitudes (positive), not signed values
          // short_quantity is the absolute value of the short position (which was negative)
          // long_quantity is already positive from the long position
          short_quantity: Math.abs(shortPos.quantity),
          long_quantity: longPos.quantity,
          short_cost_basis: shortPos.cost_basis,
          long_cost_basis: longPos.cost_basis,
        });
        }
      }
    }
  }
  
  console.log('[portfolioSync][groupSpreads] total spreads found', JSON.stringify({
    count: spreads.length,
    spreads: spreads.map(s => ({
      symbol: s.symbol,
      expiration: s.expiration,
      short_strike: s.short_strike,
      long_strike: s.long_strike,
      short_quantity: s.short_quantity,
      long_quantity: s.long_quantity,
    })),
  }));
  
  return spreads;
}

/**
 * Sync portfolio from Tradier
 * 
 * PURE MIRROR FUNCTION: Only mirrors Tradier positions to portfolio_positions table.
 * Does NOT create, update, or close trades. Does NOT detect phantoms.
 * 
 * Per design principles:
 * - Trades ≠ Portfolio
 * - portfolio_positions = raw broker legs from Tradier
 * - We never infer the portfolio purely from trades
 * 
 * CRITICAL: This function is OPTIONS-ONLY. Equities (stocks, ETFs) are intentionally
 * excluded and will be deleted from portfolio_positions if they exist.
 * If you need to track equities, use a separate table or extend this function.
 */
export async function syncPortfolioFromTradier(env: Env): Promise<{
  success: boolean;
  synced: number;
  errors: string[];
}> {
  const broker = new TradierClient(env);
  
  const result = {
    success: true,
    synced: 0,
    errors: [] as string[],
  };
  
  try {
    // 1. Fetch positions from Tradier
    const positions = await broker.getPositions();
    
    if (positions.length === 0) {
      // Defensive check: If we previously had positions and Tradier returns empty,
      // this could indicate an API issue. However, for a pure mirror, we trust Tradier.
      // If the account is truly flat, clearing is correct.
      console.log('[portfolioSync] no positions in Tradier - clearing portfolio_positions', JSON.stringify({
        note: 'Tradier returned empty positions array - clearing portfolio_positions mirror. If account should have positions, this may indicate an API issue.',
      }));
      // Clear all positions since Tradier has none
      await deletePortfolioPositionsNotInSet(env, []);
      await updatePositionsSyncTimestamp(env);
      return result;
    }
    
    console.log('[portfolioSync] fetched positions from Tradier', JSON.stringify({
      count: positions.length,
      positions: positions.map(p => ({ 
        symbol: p.symbol, 
        quantity: p.quantity,
        cost_basis: p.cost_basis,
      })),
    }));
    
    // 2. Group positions by (symbol, expiration) to batch option chain fetches
    // This reduces API calls - we fetch one chain per unique (symbol, expiration) pair
    const positionsByExpiration = new Map<string, Array<{ pos: BrokerPosition; parsed: ReturnType<typeof parseOptionSymbol> }>>();
    
    for (const pos of positions) {
      const parsed = parseOptionSymbol(pos.symbol);
      if (!parsed) {
        // Skip non-option positions (e.g., stock positions, ETFs)
        // CRITICAL: Equities are intentionally excluded from portfolio_positions
        // They will not be inserted, and any existing equity rows will be deleted
        // by deletePortfolioPositionsNotInSet since they won't be in positionKeys
        console.log('[portfolioSync] skipping non-option position', JSON.stringify({
          symbol: pos.symbol,
          quantity: pos.quantity,
          note: 'Equities are intentionally excluded from portfolio_positions - options only',
        }));
        continue;
      }
      
      const key = `${parsed.underlying}:${parsed.expiration}`;
      if (!positionsByExpiration.has(key)) {
        positionsByExpiration.set(key, []);
      }
      positionsByExpiration.get(key)!.push({ pos, parsed });
    }
    
    // 3. Fetch option chains and extract bid/ask for each position
    // This is more efficient than fetching chains per trade during monitoring
    const positionKeys: Array<{ symbol: string; expiration: string; option_type: 'call' | 'put'; strike: number; side: 'long' | 'short' }> = [];
    
    for (const [key, positionsForExp] of positionsByExpiration.entries()) {
      const [symbol, expiration] = key.split(':');
      
      try {
        // Fetch option chain once per (symbol, expiration) pair
        const optionChain = await broker.getOptionChain(symbol, expiration);
        
        // Process each position for this expiration
        // NOTE: parsed is guaranteed non-null because we filter it out before adding to positionsByExpiration
        for (const { pos, parsed } of positionsForExp) {
          if (!parsed) continue; // Type guard (should never happen, but TypeScript needs it)
          
          // Determine side: long if quantity > 0, short if quantity < 0
          const side: 'long' | 'short' = pos.quantity > 0 ? 'long' : 'short';
          const quantity = Math.abs(pos.quantity); // Always store as positive
          
          // Calculate cost_basis_per_contract
          let costBasisPerContract: number | null = null;
          if (pos.cost_basis !== null && quantity > 0) {
            costBasisPerContract = Math.abs(pos.cost_basis) / quantity;
          }
          
          // Extract bid/ask from option chain
          const optionQuote = optionChain.find(
            opt => opt.strike === parsed.strike && opt.type === parsed.type
          );
          
          const bid = optionQuote?.bid ?? null;
          const ask = optionQuote?.ask ?? null;
          const lastPrice = optionQuote?.last ?? null;
          
          // Create position key for tracking
          const positionKey = {
            symbol: parsed.underlying,
            expiration: parsed.expiration,
            option_type: parsed.type,
            strike: parsed.strike,
            side,
          };
          positionKeys.push(positionKey);
          
          // Upsert into portfolio_positions with bid/ask
          await upsertPortfolioPosition(env, {
            symbol: parsed.underlying, // Store underlying, not full option symbol
            expiration: parsed.expiration,
            option_type: parsed.type,
            strike: parsed.strike,
            side,
            quantity,
            cost_basis_per_contract: costBasisPerContract,
            last_price: lastPrice,
            bid,
            ask,
          });
          
          result.synced++;
        }
      } catch (error) {
        // If option chain fetch fails, still store position without bid/ask
        // This allows the system to continue functioning even if quote data is temporarily unavailable
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn('[portfolioSync] failed to fetch option chain for bid/ask', JSON.stringify({
          symbol,
          expiration,
          error: errorMsg,
          note: 'Storing position without bid/ask - will be updated on next sync',
        }));
        
        // Store positions without bid/ask
        for (const { pos, parsed } of positionsForExp) {
          if (!parsed) continue; // Type guard (should never happen, but TypeScript needs it)
          
          const side: 'long' | 'short' = pos.quantity > 0 ? 'long' : 'short';
          const quantity = Math.abs(pos.quantity);
          
          let costBasisPerContract: number | null = null;
          if (pos.cost_basis !== null && quantity > 0) {
            costBasisPerContract = Math.abs(pos.cost_basis) / quantity;
          }
          
          const positionKey = {
            symbol: parsed.underlying,
            expiration: parsed.expiration,
            option_type: parsed.type,
            strike: parsed.strike,
            side,
          };
          positionKeys.push(positionKey);
          
          await upsertPortfolioPosition(env, {
            symbol: parsed.underlying,
            expiration: parsed.expiration,
            option_type: parsed.type,
            strike: parsed.strike,
            side,
            quantity,
            cost_basis_per_contract: costBasisPerContract,
            last_price: null,
            bid: null,
            ask: null,
          });
          
          result.synced++;
        }
      }
    }
    
    // 4. Delete any portfolio_positions that are not in the current Tradier snapshot
    // This handles closed positions
    const deletedCount = await deletePortfolioPositionsNotInSet(env, positionKeys);
    
    console.log('[portfolioSync] sync complete', JSON.stringify({
      synced: result.synced,
      deleted: deletedCount,
      errors: result.errors.length,
      position_keys: positionKeys.length,
    }));
    
    // Update sync freshness timestamp on successful sync
    await updatePositionsSyncTimestamp(env);
    
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.success = false;
    result.errors.push(`Portfolio sync failed: ${errorMsg}`);
    console.error('[portfolioSync] sync error', JSON.stringify({
      error: errorMsg,
    }));
    // Don't update timestamp on error - sync failed
    return result;
  }
}

