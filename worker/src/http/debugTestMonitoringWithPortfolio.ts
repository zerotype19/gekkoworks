/**
 * Debug endpoint to test if monitoring can find portfolio positions for a trade
 * This verifies that getSpreadLegPositions works correctly
 */

import type { Env } from '../env';
import { getOpenTrades, getSpreadLegPositions } from '../db/queries';
import { computeSpreadPositionSnapshot } from '../core/positions';

export async function handleDebugTestMonitoringWithPortfolio(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const openTrades = await getOpenTrades(env);
    
    const results = await Promise.all(openTrades.map(async (trade) => {
      // Determine option type from strategy
      if (!trade.strategy) {
        return {
          trade_id: trade.id,
          symbol: trade.symbol,
          error: 'Trade missing strategy',
        };
      }
      
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      
      // Get spread leg positions (this is what monitoring uses)
      const { shortLeg, longLeg } = await getSpreadLegPositions(
        env,
        trade.symbol,
        trade.expiration,
        optionType,
        trade.short_strike,
        trade.long_strike
      );
      
      // Compute snapshot (this is what monitoring uses)
      const snapshot = computeSpreadPositionSnapshot(trade, shortLeg, longLeg);
      
      return {
        trade_id: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy,
        short_strike: trade.short_strike,
        long_strike: trade.long_strike,
        expiration: trade.expiration,
        trade_quantity: trade.quantity,
        portfolio_positions: {
          short_leg: shortLeg ? {
            symbol: shortLeg.symbol,
            strike: shortLeg.strike,
            side: shortLeg.side,
            quantity: shortLeg.quantity,
            bid: shortLeg.bid,
            ask: shortLeg.ask,
          } : null,
          long_leg: longLeg ? {
            symbol: longLeg.symbol,
            strike: longLeg.strike,
            side: longLeg.side,
            quantity: longLeg.quantity,
            bid: longLeg.bid,
            ask: longLeg.ask,
          } : null,
        },
        snapshot: {
          shortQty: snapshot.shortQty,
          longQty: snapshot.longQty,
          shortBid: snapshot.shortBid,
          shortAsk: snapshot.shortAsk,
          longBid: snapshot.longBid,
          longAsk: snapshot.longAsk,
        },
        can_monitor: !!(snapshot.shortBid && snapshot.shortAsk && snapshot.longBid && snapshot.longAsk),
        can_exit: snapshot.shortQty > 0 && snapshot.longQty > 0,
      };
    }));
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        total_open_trades: openTrades.length,
        results,
      }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
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

