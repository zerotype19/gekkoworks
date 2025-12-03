/**
 * Debug endpoint: /debug/concentration
 * 
 * Shows current concentration state for all symbols, including:
 * - Open trades per symbol
 * - Quantity per symbol per side
 * - Current limits
 * - Why new trades might be allowed/rejected
 */

import type { Env } from '../env';
import { getOpenTrades, getSetting } from '../db/queries';

export async function handleDebugConcentration(env: Env): Promise<Response> {
  try {
    const openTrades = await getOpenTrades(env);
    
    // Get current limits
    const maxSpreadsPerSymbol = parseInt(
      (await getSetting(env, 'MAX_SPREADS_PER_SYMBOL')) || '3',
      10
    ) || 3;
    const maxQtyPerSymbolPerSide = parseInt(
      (await getSetting(env, 'MAX_QTY_PER_SYMBOL_PER_SIDE')) || '10',
      10
    ) || 10;
    const maxTradeQuantity = parseInt(
      (await getSetting(env, 'MAX_TRADE_QUANTITY')) || '10',
      10
    ) || 10;
    
    // Group by symbol
    const bySymbol: Record<string, {
      trades: typeof openTrades;
      spreadsCount: number;
      bySide: Record<string, { trades: typeof openTrades; totalQty: number }>;
    }> = {};
    
    for (const trade of openTrades) {
      if (!trade.symbol) continue;
      
      if (!bySymbol[trade.symbol]) {
        bySymbol[trade.symbol] = {
          trades: [],
          spreadsCount: 0,
          bySide: {},
        };
      }
      
      bySymbol[trade.symbol].trades.push(trade);
      
      // Count as spread if not cancelled/closed
      if (trade.status !== 'CANCELLED' && trade.status !== 'CLOSED') {
        bySymbol[trade.symbol].spreadsCount++;
      }
      
      // Determine option side
      if (trade.strategy) {
        const isPutStrategy = trade.strategy === 'BULL_PUT_CREDIT' || trade.strategy === 'BEAR_PUT_DEBIT';
        const isShortPremium = trade.strategy === 'BULL_PUT_CREDIT' || trade.strategy === 'BEAR_CALL_CREDIT';
        const optionSide = isPutStrategy 
          ? (isShortPremium ? 'short_puts' : 'long_puts')
          : (isShortPremium ? 'short_calls' : 'long_calls');
        
        if (!bySymbol[trade.symbol].bySide[optionSide]) {
          bySymbol[trade.symbol].bySide[optionSide] = {
            trades: [],
            totalQty: 0,
          };
        }
        
        bySymbol[trade.symbol].bySide[optionSide].trades.push(trade);
        bySymbol[trade.symbol].bySide[optionSide].totalQty += (trade.quantity || 1);
      } else {
        // Trade without strategy - can't determine side
        if (!bySymbol[trade.symbol].bySide['UNKNOWN']) {
          bySymbol[trade.symbol].bySide['UNKNOWN'] = {
            trades: [],
            totalQty: 0,
          };
        }
        bySymbol[trade.symbol].bySide['UNKNOWN'].trades.push(trade);
        bySymbol[trade.symbol].bySide['UNKNOWN'].totalQty += (trade.quantity || 1);
      }
    }
    
    // Build response
    const response: Record<string, any> = {
      limits: {
        MAX_SPREADS_PER_SYMBOL: maxSpreadsPerSymbol,
        MAX_QTY_PER_SYMBOL_PER_SIDE: maxQtyPerSymbolPerSide,
        MAX_TRADE_QUANTITY: maxTradeQuantity,
      },
      symbols: {},
      summary: {
        total_open_trades: openTrades.length,
        symbols_with_trades: Object.keys(bySymbol).length,
        trades_without_strategy: openTrades.filter(t => !t.strategy).length,
      },
    };
    
    for (const [symbol, data] of Object.entries(bySymbol)) {
      const wouldBlockNewSpread = data.spreadsCount >= maxSpreadsPerSymbol;
      const sidesAtLimit: string[] = [];
      
      for (const [side, sideData] of Object.entries(data.bySide)) {
        if (side !== 'UNKNOWN' && sideData.totalQty >= maxQtyPerSymbolPerSide) {
          sidesAtLimit.push(side);
        }
      }
      
      response.symbols[symbol] = {
        spreads_count: data.spreadsCount,
        max_allowed_spreads: maxSpreadsPerSymbol,
        would_block_new_spread: wouldBlockNewSpread,
        by_side: Object.fromEntries(
          Object.entries(data.bySide).map(([side, sideData]) => [
            side,
            {
              trades_count: sideData.trades.length,
              total_quantity: sideData.totalQty,
              max_allowed: maxQtyPerSymbolPerSide,
              at_limit: side !== 'UNKNOWN' && sideData.totalQty >= maxQtyPerSymbolPerSide,
              trades: sideData.trades.map(t => ({
                id: t.id,
                strategy: t.strategy || 'MISSING',
                status: t.status,
                quantity: t.quantity || 1,
                short_strike: t.short_strike,
                long_strike: t.long_strike,
                expiration: t.expiration,
              })),
            },
          ])
        ),
        all_trades: data.trades.map(t => ({
          id: t.id,
          strategy: t.strategy || 'MISSING',
          status: t.status,
          quantity: t.quantity || 1,
          short_strike: t.short_strike,
          long_strike: t.long_strike,
          expiration: t.expiration,
        })),
      };
    }
    
    return new Response(JSON.stringify(response, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

