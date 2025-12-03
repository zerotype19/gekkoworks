/**
 * Debug Backfill Missing Trades Endpoint
 * 
 * Backfills missing trades for positions that exist in Tradier but don't have matching trades in the DB.
 * 
 * POST /v2/debug/backfill-missing-trades
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getOpenTrades, insertTrade } from '../db/queries';
import type { TradeRow } from '../types';
import { parseOptionSymbol, groupPositionsIntoSpreads } from '../engine/portfolioSync';
import { markTradeOpen } from '../engine/lifecycle';
import { getDefaultTradeQuantity } from '../core/config';

interface BackfillResult {
  timestamp: string;
  positions_found: number;
  trades_created: number;
  trades_skipped: number;
  trades_updated: number;
  errors: string[];
  created_trades: Array<{
    trade_id: string;
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    quantity: number;
    strategy: string;
    order_id: string;
    entry_price: number;
  }>;
  existing_trades: Array<{
    trade_id: string;
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    quantity: number;
    strategy: string;
    entry_price: number | null;
  }>;
}

/**
 * Determine strategy from option type and strike relationship
 */
function determineStrategy(
  optionType: 'put' | 'call',
  shortStrike: number,
  longStrike: number
): 'BULL_PUT_CREDIT' | 'BEAR_PUT_DEBIT' | 'BEAR_CALL_CREDIT' | 'BULL_CALL_DEBIT' {
  if (optionType === 'put') {
    // PUT spreads
    if (shortStrike > longStrike) {
      // Short higher strike, long lower strike = BULL_PUT_CREDIT (credit spread)
      return 'BULL_PUT_CREDIT';
    } else {
      // Short lower strike, long higher strike = BEAR_PUT_DEBIT (debit spread)
      return 'BEAR_PUT_DEBIT';
    }
  } else {
    // CALL spreads
    if (shortStrike < longStrike) {
      // Short lower strike, long higher strike = BEAR_CALL_CREDIT (credit spread)
      return 'BEAR_CALL_CREDIT';
    } else {
      // Short higher strike, long lower strike = BULL_CALL_DEBIT (debit spread)
      return 'BULL_CALL_DEBIT';
    }
  }
}

export async function handleDebugBackfillMissingTrades(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    const broker = new TradierClient(env);
    const defaultQuantity = await getDefaultTradeQuantity(env);
    
    // 1. Get positions from Tradier
    console.log('[backfillMissingTrades] fetching positions from Tradier...');
    const positions = await broker.getPositions();
    
    // 2. Group positions into spreads
    const spreads = groupPositionsIntoSpreads(positions);
    console.log('[backfillMissingTrades] grouped into spreads', JSON.stringify({
      count: spreads.length,
      spreads: spreads.map(s => ({
        symbol: s.symbol,
        expiration: s.expiration,
        short_strike: s.short_strike,
        long_strike: s.long_strike,
        quantity: s.short_quantity,
      })),
    }));
    
    // 3. Get existing trades to check for matches
    const existingTrades = await getOpenTrades(env);
    const tradeKeyMap = new Map<string, TradeRow>();
    for (const trade of existingTrades) {
      const key = `${trade.symbol}:${trade.expiration}:${trade.short_strike}:${trade.long_strike}`;
      tradeKeyMap.set(key, trade);
    }
    
    console.log('[backfillMissingTrades] existing trades', JSON.stringify({
      count: existingTrades.length,
      trades: existingTrades.map(t => ({
        symbol: t.symbol,
        expiration: t.expiration,
        short_strike: t.short_strike,
        long_strike: t.long_strike,
        quantity: t.quantity,
        strategy: t.strategy,
        entry_price: t.entry_price,
      })),
    }));
    
    // 4. Skip order matching to avoid D1 rate limits
    // Create trades from positions using cost basis, then let orderSync backfill order IDs
    console.log('[backfillMissingTrades] skipping order matching - will create trades from positions and let orderSync backfill order IDs');
    
    const result: BackfillResult = {
      timestamp: now.toISOString(),
      positions_found: spreads.length,
      trades_created: 0,
      trades_skipped: 0,
      trades_updated: 0,
      errors: [],
      created_trades: [],
      existing_trades: existingTrades.map(t => ({
        trade_id: t.id,
        symbol: t.symbol,
        expiration: t.expiration,
        short_strike: t.short_strike,
        long_strike: t.long_strike,
        quantity: t.quantity,
        strategy: t.strategy || '(unknown)',
        entry_price: t.entry_price,
      })),
    };
    
    // 5. For each spread without a matching trade, find matching order and create trade
    for (const spread of spreads) {
      const key = `${spread.symbol}:${spread.expiration}:${spread.short_strike}:${spread.long_strike}`;
      
      // Check if trade already exists
      if (tradeKeyMap.has(key)) {
        const existingTrade = tradeKeyMap.get(key)!;
        
        // Determine correct strategy from option type and strikes
        const shortPosition = positions.find(p => {
          const parsed = parseOptionSymbol(p.symbol);
          return parsed && parsed.strike === spread.short_strike && parsed.expiration === spread.expiration;
        });
        const longPosition = positions.find(p => {
          const parsed = parseOptionSymbol(p.symbol);
          return parsed && parsed.strike === spread.long_strike && parsed.expiration === spread.expiration;
        });
        
        let optionType: 'put' | 'call' | null = null;
        if (shortPosition && longPosition) {
          const shortParsed = parseOptionSymbol(shortPosition.symbol);
          const longParsed = parseOptionSymbol(longPosition.symbol);
          if (shortParsed && longParsed && shortParsed.type === longParsed.type) {
            optionType = shortParsed.type;
          }
        }
        
        const correctStrategy = optionType ? determineStrategy(optionType, spread.short_strike, spread.long_strike) : null;
        
        // Check if quantity or strategy needs updating
        const expectedQuantity = spread.short_quantity;
        const needsUpdate = existingTrade.quantity !== expectedQuantity || 
                           (correctStrategy && existingTrade.strategy !== correctStrategy);
        
        if (needsUpdate) {
          const updates: any = {};
          if (existingTrade.quantity !== expectedQuantity) {
            updates.quantity = expectedQuantity;
          }
          if (correctStrategy && existingTrade.strategy !== correctStrategy) {
            updates.strategy = correctStrategy;
          }
          
          console.log('[backfillMissingTrades] updating trade', JSON.stringify({
            tradeId: existingTrade.id,
            symbol: spread.symbol,
            expiration: spread.expiration,
            short_strike: spread.short_strike,
            long_strike: spread.long_strike,
            updates,
            old_quantity: existingTrade.quantity,
            new_quantity: expectedQuantity,
            old_strategy: existingTrade.strategy,
            new_strategy: correctStrategy,
          }));
          
          const { updateTrade } = await import('../db/queries');
          await updateTrade(env, existingTrade.id, updates);
          
          result.trades_updated++;
        } else {
          console.log('[backfillMissingTrades] trade already exists with correct data, skipping', JSON.stringify({
            symbol: spread.symbol,
            expiration: spread.expiration,
            short_strike: spread.short_strike,
            long_strike: spread.long_strike,
            quantity: existingTrade.quantity,
            strategy: existingTrade.strategy,
          }));
        }
        
        result.trades_skipped++;
        continue;
      }
      
      // CRITICAL: Going forward, all trades must have proposal_id
      // This endpoint should only update existing trades, not create new ones without proposals
      // If a position exists without a trade, it's a data integrity issue that should be resolved manually
      console.warn('[backfillMissingTrades] position without matching trade - cannot create trade without proposal_id', JSON.stringify({
        symbol: spread.symbol,
        expiration: spread.expiration,
        short_strike: spread.short_strike,
        long_strike: spread.long_strike,
        note: 'Going forward, all trades must have proposal_id. This position should have a matching trade - check data integrity.',
      }));
      
      const errorMsg = `Cannot create trade without proposal_id for position: ${spread.symbol} ${spread.expiration} ${spread.short_strike}/${spread.long_strike}. All trades must be created from proposals.`;
      result.errors.push(errorMsg);
      continue;
    }
    
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[backfillMissingTrades] error', errorMsg);
    return new Response(JSON.stringify({
      error: errorMsg,
      timestamp: now.toISOString(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

