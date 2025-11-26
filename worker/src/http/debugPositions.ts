import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getOpenTrades } from '../db/queries';
import type { TradeRow } from '../types';

/**
 * Debug endpoint: return raw Tradier positions payload plus our normalized view,
 * and compare with open trades in the database.
 * 
 * GET /debug/positions
 */
export async function handleDebugPositions(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const client = new TradierClient(env);

    // Call underlying API directly to inspect raw structure
    const url = `https://${env.TRADIER_ENV === 'live' ? 'api.tradier.com' : 'sandbox.tradier.com'}/v1/accounts/${env.TRADIER_ACCOUNT_ID}/positions`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.TRADIER_API_TOKEN}`,
        Accept: 'application/json',
      },
    });

    const raw = await response.json();
    const normalized = await client.getPositions();
    
    // Get open trades from DB
    const dbTrades = await getOpenTrades(env);
    
    // Helper function to build option symbol
    function buildOptionSymbol(symbol: string, expiration: string, strike: number, optionType: 'call' | 'put'): string {
      const expirationDate = new Date(expiration);
      const year = expirationDate.getFullYear().toString().slice(-2);
      const month = (expirationDate.getMonth() + 1).toString().padStart(2, '0');
      const day = expirationDate.getDate().toString().padStart(2, '0');
      const typeChar = optionType === 'call' ? 'C' : 'P';
      const strikeStr = (strike * 1000).toFixed(0).padStart(8, '0');
      return `${symbol}${year}${month}${day}${typeChar}${strikeStr}`;
    }
    
    // Helper function to determine what exit order would be placed
    function getExitOrderDetails(trade: TradeRow, shortSymbol: string, longSymbol: string) {
      const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
      
      // For credit spreads (BULL_PUT_CREDIT, BEAR_CALL_CREDIT):
      //   Exit: buy_to_close short, sell_to_close long
      // For debit spreads (BULL_CALL_DEBIT, BEAR_PUT_DEBIT):
      //   Exit: sell_to_close long, buy_to_close short
      
      let leg0: { option_symbol: string; side: string; quantity: number };
      let leg1: { option_symbol: string; side: string; quantity: number };
      
      if (isDebitSpread) {
        // Debit spread exit: sell_to_close long, buy_to_close short
        leg0 = {
          option_symbol: longSymbol,
          side: 'sell_to_close',
          quantity: trade.quantity,
        };
        leg1 = {
          option_symbol: shortSymbol,
          side: 'buy_to_close',
          quantity: trade.quantity,
        };
      } else {
        // Credit spread exit: buy_to_close short, sell_to_close long
        leg0 = {
          option_symbol: shortSymbol,
          side: 'buy_to_close',
          quantity: trade.quantity,
        };
        leg1 = {
          option_symbol: longSymbol,
          side: 'sell_to_close',
          quantity: trade.quantity,
        };
      }
      
      return {
        strategy: trade.strategy,
        is_debit_spread: isDebitSpread,
        order_type: 'limit', // Always 'limit' for multileg orders per Tradier API
        legs: [leg0, leg1],
        explanation: isDebitSpread
          ? 'Debit spread exit: sell_to_close long leg, buy_to_close short leg'
          : 'Credit spread exit: buy_to_close short leg, sell_to_close long leg',
      };
    }
    
    // Build option symbols for each trade and compare with positions
    const comparisons = await Promise.all(dbTrades.map(async (trade) => {
      // Determine option type based on strategy
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      
      // Build expected option symbols
      const expectedShortSymbol = buildOptionSymbol(trade.symbol, trade.expiration, trade.short_strike, optionType);
      const expectedLongSymbol = buildOptionSymbol(trade.symbol, trade.expiration, trade.long_strike, optionType);
      
      // Find matching positions
      const shortPosition = normalized.find(p => p.symbol === expectedShortSymbol);
      const longPosition = normalized.find(p => p.symbol === expectedLongSymbol);
      
      // Calculate available quantity for exit
      const availableShortQty = shortPosition ? Math.abs(shortPosition.quantity) : 0;
      const availableLongQty = longPosition ? Math.abs(longPosition.quantity) : 0;
      const availableQty = Math.min(availableShortQty, availableLongQty);
      
      // Get exit order details
      const exitOrderDetails = getExitOrderDetails(trade, expectedShortSymbol, expectedLongSymbol);
      
      return {
        trade_id: trade.id,
        symbol: trade.symbol,
        expiration: trade.expiration,
        strategy: trade.strategy,
        short_strike: trade.short_strike,
        long_strike: trade.long_strike,
        db_quantity: trade.quantity,
        expected_short_symbol: expectedShortSymbol,
        expected_long_symbol: expectedLongSymbol,
        short_position: shortPosition ? {
          symbol: shortPosition.symbol,
          quantity: shortPosition.quantity,
          cost_basis: shortPosition.cost_basis,
        } : null,
        long_position: longPosition ? {
          symbol: longPosition.symbol,
          quantity: longPosition.quantity,
          cost_basis: longPosition.cost_basis,
        } : null,
        quantity_match: shortPosition && longPosition
          ? Math.abs(shortPosition.quantity) === trade.quantity && Math.abs(longPosition.quantity) === trade.quantity
          : false,
        quantity_details: shortPosition && longPosition ? {
          db_quantity: trade.quantity,
          tradier_short_qty: shortPosition.quantity,
          tradier_long_qty: longPosition.quantity,
          tradier_short_abs: Math.abs(shortPosition.quantity),
          tradier_long_abs: Math.abs(longPosition.quantity),
          available_short_qty: availableShortQty,
          available_long_qty: availableLongQty,
          available_qty_for_exit: availableQty,
          would_need_to_downsize: availableQty < trade.quantity,
        } : null,
        exit_order_details: exitOrderDetails,
        exit_order_would_use_quantity: availableQty > 0 ? availableQty : trade.quantity,
      };
    }));

    return new Response(
      JSON.stringify(
        {
          ok: response.ok,
          status: response.status,
          raw,
          normalized,
          db_trades: dbTrades.map(t => ({
            id: t.id,
            symbol: t.symbol,
            expiration: t.expiration,
            strategy: t.strategy,
            short_strike: t.short_strike,
            long_strike: t.long_strike,
            quantity: t.quantity,
            status: t.status,
          })),
          comparisons,
          summary: {
            db_trade_count: dbTrades.length,
            tradier_position_count: normalized.length,
            matches: comparisons.filter(c => c.quantity_match).length,
            mismatches: comparisons.filter(c => !c.quantity_match).length,
            missing_positions: comparisons.filter(c => !c.short_position || !c.long_position).length,
          },
        },
        null,
        2
      ),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify(
        {
          error: error?.message ?? String(error),
        },
        null,
        2
      ),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}


