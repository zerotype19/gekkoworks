/**
 * Portfolio Sync Engine
 * 
 * Maintains real-time sync between Tradier positions and our database.
 * Ensures we monitor ALL open positions, not just ones we created.
 */

import type { Env } from '../env';
import type { TradeRow, BrokerPosition } from '../types';
import { TradierClient } from '../broker/tradierClient';
import { getOpenTrades, insertTrade } from '../db/queries';
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
 * Will return null for:
 * - Weeklies with extra letters in underlying (e.g., SPYW)
 * - Index options with different vendor formats
 * - Any non-standard symbol encoding
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
 * For BPCS, we expect:
 * - Short put: quantity < 0
 * - Long put: quantity > 0
 * Both same expiration, 5-point width
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
  
  // Group by expiration
  const byExpiration = new Map<string, BrokerPosition[]>();
  
  for (const pos of positions) {
    const parsed = parseOptionSymbol(pos.symbol);
    if (!parsed || parsed.type !== 'put') {
      continue; // Only track puts for BPCS
    }
    
    if (!byExpiration.has(parsed.expiration)) {
      byExpiration.set(parsed.expiration, []);
    }
    byExpiration.get(parsed.expiration)!.push(pos);
  }
  
  // For each expiration, find matching spreads
  for (const [expiration, expPositions] of byExpiration.entries()) {
    // Find short puts (quantity < 0)
    const shortPuts = expPositions.filter(p => {
      const parsed = parseOptionSymbol(p.symbol);
      return parsed && parsed.type === 'put' && p.quantity < 0;
    });
    
    // Find long puts (quantity > 0)
    const longPuts = expPositions.filter(p => {
      const parsed = parseOptionSymbol(p.symbol);
      return parsed && parsed.type === 'put' && p.quantity > 0;
    });
    
    // Match short and long puts that form a 5-point spread
    // Use a Set to de-dup spreads by (underlying, expiration, short_strike, long_strike)
    const spreadKeys = new Set<string>();
    
    for (const shortPut of shortPuts) {
      const shortParsed = parseOptionSymbol(shortPut.symbol);
      if (!shortParsed) continue;
      
      for (const longPut of longPuts) {
        const longParsed = parseOptionSymbol(longPut.symbol);
        if (!longParsed) continue;
        
        // CRITICAL: Ensure both legs are from the same underlying
        // Prevents creating "spreads" that mix different underlyings (e.g., SPY + QQQ)
        if (shortParsed.underlying !== longParsed.underlying) {
          continue;
        }
        
        // Check if they form a 5-point spread (short strike - long strike = 5)
        const width = shortParsed.strike - longParsed.strike;
        if (width === 5 && Math.abs(shortPut.quantity) === longPut.quantity) {
          // Create de-dup key to prevent double-counting the same spread
          const spreadKey = `${shortParsed.underlying}-${expiration}-${shortParsed.strike}-${longParsed.strike}`;
          if (spreadKeys.has(spreadKey)) {
            continue; // Already added this spread
          }
          spreadKeys.add(spreadKey);
          
          spreads.push({
            symbol: shortParsed.underlying,
            expiration,
            short_strike: shortParsed.strike,
            long_strike: longParsed.strike,
            short_quantity: Math.abs(shortPut.quantity),
            long_quantity: longPut.quantity,
            short_cost_basis: shortPut.cost_basis,
            long_cost_basis: longPut.cost_basis,
          });
        }
      }
    }
  }
  
  return spreads;
}

/**
 * Sync portfolio from Tradier
 * 
 * Fetches all positions from Tradier, reconciles with our database,
 * and creates trade records for any positions we don't have.
 */
export async function syncPortfolioFromTradier(env: Env): Promise<{
  synced: number;
  created: number;
  errors: string[];
}> {
  const broker = new TradierClient(env);
  
  const result = {
    synced: 0,
    created: 0,
    errors: [] as string[],
  };
  
  try {
    // 1. Fetch positions from Tradier
    const positions = await broker.getPositions();
    
    if (positions.length === 0) {
      console.log('[portfolioSync] no positions in Tradier');
      // Still update timestamp - empty positions is valid sync result
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
    
    // Debug: Check parsing
    for (const pos of positions) {
      const parsed = parseOptionSymbol(pos.symbol);
      console.log('[portfolioSync] parsed position', JSON.stringify({
        symbol: pos.symbol,
        parsed,
        quantity: pos.quantity,
      }));
    }
    
    // 2. Group into spreads
    const spreads = groupPositionsIntoSpreads(positions);
    
    if (spreads.length === 0) {
      console.log('[portfolioSync] no valid BPCS spreads found in positions');
      // Still update timestamp - no spreads is valid sync result
      await updatePositionsSyncTimestamp(env);
      return result;
    }
    
    console.log('[portfolioSync] grouped into spreads', JSON.stringify({
      count: spreads.length,
      spreads: spreads.map(s => ({
        symbol: s.symbol,
        expiration: s.expiration,
        short_strike: s.short_strike,
        long_strike: s.long_strike,
      })),
    }));
    
    // 3. Get our open trades
    const ourTrades = await getOpenTrades(env);
    
    // 4. For each spread in Tradier, check if we have it in our DB
    for (const spread of spreads) {
      result.synced++;
      
      // Try to find matching trade in our DB
      const matchingTrade = ourTrades.find(t => 
        t.symbol === spread.symbol &&
        t.expiration === spread.expiration &&
        t.short_strike === spread.short_strike &&
        t.long_strike === spread.long_strike &&
        t.status === 'OPEN'
      );
      
      if (matchingTrade) {
        // Trade exists - update quantity and entry_price if needed
        const expectedQuantity = spread.short_quantity; // Should equal long_quantity
        const { updateTrade } = await import('../db/queries');
        const updates: Partial<import('../types').TradeRow> = {};
        
        // Update quantity ONLY if trade doesn't have one set
        // CRITICAL: Do NOT update quantity if it's already set, because Tradier aggregates
        // multiple trades with the same strikes into one position. We should only set quantity
        // for trades that were created from positions (where quantity was not set initially).
        if (matchingTrade.quantity == null && expectedQuantity > 0) {
          updates.quantity = expectedQuantity;
          console.log('[portfolioSync] setting trade quantity from position', JSON.stringify({
            tradeId: matchingTrade.id,
            symbol: spread.symbol,
            expiration: spread.expiration,
            quantity: expectedQuantity,
            note: 'Trade had no quantity set, using Tradier position quantity',
          }));
        } else if (matchingTrade.quantity != null && matchingTrade.quantity !== expectedQuantity) {
          // Log a warning but don't update - Tradier may have aggregated multiple trades
          console.log('[portfolioSync] quantity mismatch (not updating)', JSON.stringify({
            tradeId: matchingTrade.id,
            symbol: spread.symbol,
            expiration: spread.expiration,
            trade_quantity: matchingTrade.quantity,
            tradier_quantity: expectedQuantity,
            note: 'Tradier position may be aggregated from multiple trades - not updating',
          }));
        }
        
        // Calculate entry_price from cost_basis if trade is missing it
        // NOTE: This backfill assumes BULL_PUT_CREDIT semantics (credit spread)
        // If a trade was created with different strategy/width, this will force credit-spread risk calculations
        let entryPrice: number | null = null;
        if ((!matchingTrade.entry_price || matchingTrade.entry_price <= 0) && 
            spread.short_cost_basis !== null && spread.long_cost_basis !== null && 
            spread.short_quantity > 0) {
          // Convert from cents to dollars and calculate per-contract
          const shortCreditCents = Math.abs(spread.short_cost_basis);
          const longDebitCents = Math.abs(spread.long_cost_basis);
          const netCreditCents = shortCreditCents - longDebitCents;
          entryPrice = netCreditCents / 100 / spread.short_quantity;
          
          // Sanity check: entry price should be positive for credit spread and reasonable (0.20 to 3.00)
          if (entryPrice >= 0.20 && entryPrice <= 3.00) {
            updates.entry_price = entryPrice;
            // Also update max_profit and max_loss
            // CRITICAL: These formulas assume credit spread (BULL_PUT_CREDIT)
            // This will override any previous risk calculations if trade had different strategy
            updates.max_profit = entryPrice * expectedQuantity;
            updates.max_loss = (matchingTrade.width - entryPrice) * expectedQuantity;
            console.log('[portfolioSync] backfilling entry_price from cost_basis', JSON.stringify({
              tradeId: matchingTrade.id,
              symbol: spread.symbol,
              expiration: spread.expiration,
              short_cost_basis: spread.short_cost_basis,
              long_cost_basis: spread.long_cost_basis,
              entry_price: entryPrice,
            }));
          } else {
            console.log('[portfolioSync] calculated entry_price out of bounds, skipping', JSON.stringify({
              tradeId: matchingTrade.id,
              calculated_entry_price: entryPrice,
              short_cost_basis: spread.short_cost_basis,
              long_cost_basis: spread.long_cost_basis,
            }));
          }
        }
        
        // Apply updates if any
        if (Object.keys(updates).length > 0) {
          await updateTrade(env, matchingTrade.id, updates);
        } else {
          console.log('[portfolioSync] trade already in DB', JSON.stringify({
            tradeId: matchingTrade.id,
            symbol: spread.symbol,
            expiration: spread.expiration,
            quantity: matchingTrade.quantity,
            entry_price: matchingTrade.entry_price,
          }));
        }
        continue;
      }
      
      // Trade doesn't exist in our DB - verify it's actually a valid spread before creating
      // Only create if we can verify the options exist in the chain
      console.log('[portfolioSync] checking if position is valid', JSON.stringify({
        symbol: spread.symbol,
        expiration: spread.expiration,
        short_strike: spread.short_strike,
        long_strike: spread.long_strike,
      }));
      
      try {
        // Verify the options exist in the chain before creating trade record
        const chain = await broker.getOptionChain(spread.symbol, spread.expiration);
        const shortPut = chain.find(
          opt => opt.strike === spread.short_strike && opt.type === 'put'
        );
        const longPut = chain.find(
          opt => opt.strike === spread.long_strike && opt.type === 'put'
        );
        
        if (!shortPut || !longPut) {
          // Non-fatal: single position issue shouldn't block sync
          const warning = `Options not found in chain for ${spread.symbol} ${spread.expiration}`;
          console.log('[portfolioSync] skipping position - options not found in chain', JSON.stringify({
            symbol: spread.symbol,
            expiration: spread.expiration,
            short_strike: spread.short_strike,
            long_strike: spread.long_strike,
            shortPutFound: !!shortPut,
            longPutFound: !!longPut,
            note: 'Non-fatal - single position issue',
          }));
          // Track as warning but don't block sync timestamp update
          result.errors.push(warning);
          continue;
        }
        
        // Calculate entry price from cost basis
        // Tradier returns cost_basis in cents (dollars * 100)
        // For a credit spread:
        // - Short put (sold): cost_basis is positive (credit received, total for all contracts)
        // - Long put (bought): cost_basis is negative (debit paid, total for all contracts)
        // Net credit per contract = (short_cost_basis - |long_cost_basis|) / 100 / quantity
        let entryPrice: number | null = null;
        if (spread.short_cost_basis !== null && spread.long_cost_basis !== null && spread.short_quantity > 0) {
          // Convert from cents to dollars and calculate per-contract
          // Short cost_basis is positive (credit received), long is negative (debit paid)
          const shortCreditCents = Math.abs(spread.short_cost_basis); // Credit received in cents
          const longDebitCents = Math.abs(spread.long_cost_basis); // Debit paid in cents (already negative, so abs)
          
          // Net credit total (in cents) = credit received - debit paid
          const netCreditCents = shortCreditCents - longDebitCents;
          
          // Convert to dollars and divide by quantity to get per-contract price
          entryPrice = netCreditCents / 100 / spread.short_quantity;
          
          // Sanity check: entry price should be positive for credit spread and reasonable (0.20 to 3.00)
          if (entryPrice < 0.20 || entryPrice > 3.00) {
            console.log('[portfolioSync] entry price out of bounds, using null', JSON.stringify({
              short_cost_basis: spread.short_cost_basis,
              long_cost_basis: spread.long_cost_basis,
              short_quantity: spread.short_quantity,
              net_credit_cents: netCreditCents,
              calculated_entry_price: entryPrice,
            }));
            entryPrice = null; // Invalid, don't set it
          } else {
            console.log('[portfolioSync] calculated entry price from cost_basis', JSON.stringify({
              short_cost_basis: spread.short_cost_basis,
              long_cost_basis: spread.long_cost_basis,
              short_quantity: spread.short_quantity,
              net_credit_cents: netCreditCents,
              entry_price_per_contract: entryPrice,
            }));
          }
        }
        
        // Try to find matching order (orderSync will link it later if not found)
        // For now, create trade without order ID - it will be managed by Gekkoworks
        const quantity = spread.short_quantity; // Should equal long_quantity for valid spread
        
        // NOTE: This module only creates BULL_PUT_CREDIT spreads from positions
        // Grouping logic ensures: puts only, short strike > long strike, width = 5
        // If this logic is extended to other strategies, max_profit/max_loss formulas must be updated
        const newTrade: Omit<TradeRow, 'created_at' | 'updated_at'> = {
          id: crypto.randomUUID(),
          proposal_id: null, // May be linked later via order matching
          symbol: spread.symbol,
          expiration: spread.expiration,
          short_strike: spread.short_strike,
          long_strike: spread.long_strike,
          width: 5, // Hard-coded - this module only handles 5-point spreads
          quantity: quantity, // Store actual quantity from Tradier
          entry_price: entryPrice,
          exit_price: null,
          // CRITICAL: These formulas are credit-spread only (BULL_PUT_CREDIT)
          // For credit spreads: max_profit = credit received, max_loss = width - credit
          // If extended to debit spreads, these formulas must be inverted
          max_profit: entryPrice ? entryPrice * quantity : null, // Max profit per contract * quantity
          max_loss: entryPrice ? (5 - entryPrice) * quantity : null, // Max loss per contract * quantity
          strategy: 'BULL_PUT_CREDIT', // Explicitly set - grouping logic ensures this is always BPCS
          status: 'OPEN', // Assume it's open if it's in Tradier positions
          exit_reason: null,
          broker_order_id_open: null, // Will be linked by orderSync if matching order found
          broker_order_id_close: null,
          opened_at: new Date().toISOString(), // Approximate
          closed_at: null,
          realized_pnl: null,
        };
        
        await insertTrade(env, newTrade);
        result.created++;
        
        console.log('[portfolioSync] created trade from position', JSON.stringify({
          tradeId: newTrade.id,
          symbol: spread.symbol,
          expiration: spread.expiration,
          note: 'Order ID will be linked by orderSync if matching order found',
        }));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to create trade for ${spread.symbol} ${spread.expiration}: ${errorMsg}`);
        console.error('[portfolioSync] error creating trade from position', JSON.stringify({
          error: errorMsg,
          spread,
        }));
      }
    }
    
    console.log('[portfolioSync] sync complete', JSON.stringify({
      synced: result.synced,
      created: result.created,
      errors: result.errors.length,
    }));
    
    // Update sync freshness timestamp on successful sync
    // Only block timestamp update on fatal errors (sync failure, not individual position issues)
    // Individual position errors (e.g., options not in chain) are non-fatal and shouldn't block sync
    // The top-level catch handles fatal errors, so if we reach here, sync succeeded
    await updatePositionsSyncTimestamp(env);
    
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Portfolio sync failed: ${errorMsg}`);
    console.error('[portfolioSync] sync error', JSON.stringify({
      error: errorMsg,
    }));
    // Don't update timestamp on error - sync failed
    return result;
  }
}

