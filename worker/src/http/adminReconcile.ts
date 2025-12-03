/**
 * Reconciliation Endpoint
 * 
 * Compares Tradier positions/orders with local DB state.
 * Per Tradier-first spec: Tradier is source of truth, D1 is cache.
 * 
 * POST /v2/admin/reconcile?autoRepair=true|false
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getOpenTrades, getAllTrades, updateTrade, insertTrade } from '../db/queries';
import type { TradeRow } from '../types';
import { parseOptionSymbol, groupPositionsIntoSpreads } from '../engine/portfolioSync';

interface ReconciliationMismatch {
  type: 'orphaned_trade' | 'discovered_position' | 'quantity_mismatch' | 'strike_mismatch' | 'spread_width_mismatch' | 'order_status_mismatch';
  trade_id?: string;
  tradier_position?: {
    symbol: string;
    quantity: number;
    cost_basis: number | null;
  };
  local_trade?: {
    id: string;
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    quantity: number;
    status: string;
  };
  details: string;
}

interface ReconciliationResult {
  timestamp: string;
  mismatches: ReconciliationMismatch[];
  repaired: ReconciliationMismatch[];
  summary: {
    total_tradier_positions: number;
    total_local_trades: number;
    mismatches_found: number;
    repaired_count: number;
  };
}

/**
 * Match a Tradier position to a local trade
 * 
 * NOTE: This function is used for individual position matching, but the main
 * reconciliation logic uses groupPositionsIntoSpreads which handles all strategy types.
 * This function is kept for backward compatibility but may not be used in the main flow.
 */
function matchPositionToTrade(
  position: { symbol: string; quantity: number; cost_basis: number | null },
  trades: TradeRow[]
): TradeRow | null {
  const parsed = parseOptionSymbol(position.symbol);
  if (!parsed) {
    return null; // Can't parse option symbol
  }
  
  // Find trade with matching symbol, expiration, and strike
  // For short positions (quantity < 0), match to short_strike
  // For long positions (quantity > 0), match to long_strike
  // Note: We match regardless of option type (put/call) since trades can be either
  if (position.quantity < 0) {
    // Short position - match to short_strike
    return trades.find(
      t => t.symbol === parsed.underlying &&
           t.expiration === parsed.expiration &&
           t.short_strike === parsed.strike &&
           t.status === 'OPEN'
    ) || null;
  } else {
    // Long position - match to long_strike
    return trades.find(
      t => t.symbol === parsed.underlying &&
           t.expiration === parsed.expiration &&
           t.long_strike === parsed.strike &&
           t.status === 'OPEN'
    ) || null;
  }
}

// Use groupPositionsIntoSpreads from portfolioSync

export async function handleAdminReconcile(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const autoRepair = url.searchParams.get('autoRepair') === 'true';
  
  const now = new Date();
  const mismatches: ReconciliationMismatch[] = [];
  const repaired: ReconciliationMismatch[] = [];
  
  try {
    const broker = new TradierClient(env);
    
    // 1. Fetch all positions from Tradier
    const tradierPositions = await broker.getPositions();
    
    // 2. Fetch all local trades
    const localTrades = await getAllTrades(env);
    const openTrades = localTrades.filter(t => t.status === 'OPEN');
    
    // 3. Group Tradier positions into spreads
    const tradierSpreads = groupPositionsIntoSpreads(tradierPositions);
    
    // 4. Check for orphaned local trades (exist in DB but not in Tradier)
    for (const trade of openTrades) {
      const matchingSpread = tradierSpreads.find(
        s => s.symbol === trade.symbol &&
             s.expiration === trade.expiration &&
             s.short_strike === trade.short_strike &&
             s.long_strike === trade.long_strike
      );
      
      if (!matchingSpread) {
        mismatches.push({
          type: 'orphaned_trade',
          trade_id: trade.id,
          local_trade: {
            id: trade.id,
            symbol: trade.symbol,
            expiration: trade.expiration,
            short_strike: trade.short_strike,
            long_strike: trade.long_strike,
            quantity: trade.quantity,
            status: trade.status,
          },
          details: `Trade exists in DB but not in Tradier positions`,
        });
        
        if (autoRepair) {
          // Mark as DESYNCED and CLOSED
          await updateTrade(env, trade.id, {
            status: 'CLOSED',
            exit_reason: 'UNKNOWN',
            closed_at: now.toISOString(),
          });
          repaired.push(mismatches[mismatches.length - 1]);
        }
      } else {
        // Check for quantity mismatch
        if (matchingSpread.short_quantity !== trade.quantity) {
          mismatches.push({
            type: 'quantity_mismatch',
            trade_id: trade.id,
            local_trade: {
              id: trade.id,
              symbol: trade.symbol,
              expiration: trade.expiration,
              short_strike: trade.short_strike,
              long_strike: trade.long_strike,
              quantity: trade.quantity,
              status: trade.status,
            },
            details: `Quantity mismatch: local=${trade.quantity}, tradier=${matchingSpread.short_quantity}`,
          });
          
          if (autoRepair) {
            // Update quantity to match Tradier
            await updateTrade(env, trade.id, { quantity: matchingSpread.short_quantity });
            repaired.push(mismatches[mismatches.length - 1]);
          }
        }
        
        // Check for strike mismatch
        if (matchingSpread.short_strike !== trade.short_strike || matchingSpread.long_strike !== trade.long_strike) {
          mismatches.push({
            type: 'strike_mismatch',
            trade_id: trade.id,
            local_trade: {
              id: trade.id,
              symbol: trade.symbol,
              expiration: trade.expiration,
              short_strike: trade.short_strike,
              long_strike: trade.long_strike,
              quantity: trade.quantity,
              status: trade.status,
            },
            details: `Strike mismatch: local=(${trade.short_strike}/${trade.long_strike}), tradier=(${matchingSpread.short_strike}/${matchingSpread.long_strike})`,
          });
          
          if (autoRepair) {
            // Update strikes to match Tradier
            await updateTrade(env, trade.id, {
              short_strike: matchingSpread.short_strike,
              long_strike: matchingSpread.long_strike,
            });
            repaired.push(mismatches[mismatches.length - 1]);
          }
        }
        
        // Check for spread width mismatch
        const tradierWidth = Math.abs(matchingSpread.short_strike - matchingSpread.long_strike);
        if (tradierWidth !== trade.width) {
          mismatches.push({
            type: 'spread_width_mismatch',
            trade_id: trade.id,
            local_trade: {
              id: trade.id,
              symbol: trade.symbol,
              expiration: trade.expiration,
              short_strike: trade.short_strike,
              long_strike: trade.long_strike,
              quantity: trade.quantity,
              status: trade.status,
            },
            details: `Spread width mismatch: local=${trade.width}, tradier=${tradierWidth}`,
          });
          
          if (autoRepair) {
            // Update width to match Tradier
            await updateTrade(env, trade.id, { width: tradierWidth });
            repaired.push(mismatches[mismatches.length - 1]);
          }
        }
      }
    }
    
    // 5. Check for discovered positions (exist in Tradier but not in DB)
    for (const spread of tradierSpreads) {
      const matchingTrade = openTrades.find(
        t => t.symbol === spread.symbol &&
             t.expiration === spread.expiration &&
             t.short_strike === spread.short_strike &&
             t.long_strike === spread.long_strike
      );
      
      if (!matchingTrade) {
        mismatches.push({
          type: 'discovered_position',
          tradier_position: {
            symbol: spread.symbol,
            quantity: spread.short_quantity,
            cost_basis: spread.short_cost_basis,
          },
          details: `Position exists in Tradier but not in DB: ${spread.symbol} ${spread.expiration} ${spread.short_strike}/${spread.long_strike}`,
        });
        
        if (autoRepair) {
          // Create trade record from Tradier position
          // We need to determine strategy and calculate entry price correctly
          // Use the same logic as portfolioSync
          try {
            const chain = await broker.getOptionChain(spread.symbol, spread.expiration);
            const shortOption = chain.find(opt => opt.strike === spread.short_strike);
            const longOption = chain.find(opt => opt.strike === spread.long_strike);
            
            if (!shortOption || !longOption || shortOption.type !== longOption.type) {
              throw new Error('Cannot determine option type from chain');
            }
            
            const optionType = shortOption.type;
            let strategy: string;
            if (optionType === 'put') {
              strategy = spread.short_strike > spread.long_strike ? 'BULL_PUT_CREDIT' : 'BEAR_PUT_DEBIT';
            } else {
              strategy = spread.short_strike < spread.long_strike ? 'BEAR_CALL_CREDIT' : 'BULL_CALL_DEBIT';
            }
            
            const isCreditSpread = strategy === 'BULL_PUT_CREDIT' || strategy === 'BEAR_CALL_CREDIT';
            let entryPrice: number | null = null;
            
            if (spread.short_cost_basis !== null && spread.long_cost_basis !== null && spread.short_quantity > 0) {
              const shortCents = Math.abs(spread.short_cost_basis);
              const longCents = Math.abs(spread.long_cost_basis);
              const netPremiumCents = isCreditSpread 
                ? shortCents - longCents
                : longCents - shortCents;
              entryPrice = Math.abs(netPremiumCents) / 100 / spread.short_quantity;
              
              if (entryPrice < 0.20 || entryPrice > 3.00) {
                entryPrice = null; // Invalid, don't set it
              }
            }
            
            let maxProfit: number | null = null;
            let maxLoss: number | null = null;
            const width = Math.abs(spread.short_strike - spread.long_strike);
            
            if (entryPrice) {
              if (isCreditSpread) {
                maxProfit = entryPrice * spread.short_quantity;
                maxLoss = (width - entryPrice) * spread.short_quantity;
              } else {
                maxLoss = entryPrice * spread.short_quantity;
                maxProfit = (width - entryPrice) * spread.short_quantity;
              }
            }
            
            const newTrade: Omit<TradeRow, 'created_at' | 'updated_at'> = {
              id: crypto.randomUUID(),
              proposal_id: null,
              symbol: spread.symbol,
              expiration: spread.expiration,
              short_strike: spread.short_strike,
              long_strike: spread.long_strike,
              width: width,
              quantity: spread.short_quantity,
              entry_price: entryPrice,
              exit_price: null,
              max_profit: maxProfit,
              max_loss: maxLoss,
              strategy: strategy as any,
              status: 'OPEN',
              exit_reason: null,
              broker_order_id_open: null,
              broker_order_id_close: null,
              opened_at: now.toISOString(),
              closed_at: null,
              realized_pnl: null,
            };
            
            await insertTrade(env, newTrade);
            repaired.push(mismatches[mismatches.length - 1]);
          } catch (error) {
            console.error('[reconcile] failed to create trade from position', JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              spread,
            }));
            // Don't add to repaired if we couldn't create the trade
          }
        }
      }
    }
    
    const result: ReconciliationResult = {
      timestamp: now.toISOString(),
      mismatches,
      repaired: autoRepair ? repaired : [],
      summary: {
        total_tradier_positions: tradierPositions.length,
        total_local_trades: openTrades.length,
        mismatches_found: mismatches.length,
        repaired_count: repaired.length,
      },
    };
    
    return new Response(
      JSON.stringify(result, null, 2),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[reconcile] error', JSON.stringify({ error: errorMsg }));
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMsg,
        timestamp: now.toISOString(),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

