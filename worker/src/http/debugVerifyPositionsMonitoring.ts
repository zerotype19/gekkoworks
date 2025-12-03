/**
 * Debug endpoint to verify all Tradier positions are being monitored
 * Compares Tradier positions with our open trades and portfolio_positions
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { getOpenTrades } from '../db/queries';
import { TradierClient } from '../broker/tradierClient';
import { getSpreadLegPositions } from '../db/queries';
import { parseOptionSymbol } from '../engine/portfolioSync';

export async function handleDebugVerifyPositionsMonitoring(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const broker = new TradierClient(env);
    const db = getDB(env);
    
    // Get all positions from Tradier (source of truth)
    let tradierPositions: any[] = [];
    try {
      tradierPositions = await broker.getPositions();
    } catch (err) {
      return new Response(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          error: 'Failed to fetch Tradier positions',
          error_message: err instanceof Error ? err.message : String(err),
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Filter to only option positions (non-zero quantity)
    // Parse option symbols to identify options vs stocks
    const optionPositions: any[] = [];
    for (const pos of tradierPositions) {
      if (!pos || pos.quantity === 0) continue;
      
      // Try to parse as option symbol (OCC format: SPY251212P00645000)
      const parsed = parseOptionSymbol(pos.symbol);
      if (parsed) {
        optionPositions.push({
          ...pos,
          parsed,
        });
      }
    }
    
    // Get all open trades from our database
    const openTrades = await getOpenTrades(env);
    
    // Get all positions from portfolio_positions
    const portfolioPositions = await db.prepare(`
      SELECT * FROM portfolio_positions 
      WHERE quantity != 0
      ORDER BY symbol, expiration, strike, option_type
    `).all();
    
    // Check each Tradier position to see if it's tracked
    const positionAnalysis: any[] = [];
    
    for (const pos of optionPositions) {
      const parsed = pos.parsed; // Already parsed above
      
      // Find matching portfolio position by symbol
      const portfolioMatch = (portfolioPositions.results || []).find((pp: any) => 
        pp.symbol === pos.symbol
      );
      
      // Try to find a trade that includes this position
      // Match by underlying, expiration, strike, and type
      let matchedTrade = null;
      for (const trade of openTrades) {
        // Determine option type from strategy
        const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
        
        // Check if this position matches the trade's underlying, expiration, and type
        if (trade.symbol === parsed.underlying && 
            trade.expiration === parsed.expiration &&
            optionType === parsed.type) {
          
          // Check if strike matches either leg
          if (trade.short_strike === parsed.strike || trade.long_strike === parsed.strike) {
            // Get spread leg positions to verify quantity
            try {
              const { shortLeg, longLeg } = await getSpreadLegPositions(
                env,
                trade.symbol,
                trade.expiration,
                optionType,
                trade.short_strike,
                trade.long_strike
              );
              
              // Check if this position matches either leg by symbol and quantity
              const absQty = Math.abs(pos.quantity);
              if (shortLeg && shortLeg.symbol === pos.symbol && Math.abs(shortLeg.quantity - absQty) < 0.01) {
                matchedTrade = trade;
                break;
              }
              if (longLeg && longLeg.symbol === pos.symbol && Math.abs(longLeg.quantity - absQty) < 0.01) {
                matchedTrade = trade;
                break;
              }
            } catch (err) {
              // If we can't get leg positions, still match by strike (less precise)
              matchedTrade = trade;
              break;
            }
          }
        }
      }
      
      positionAnalysis.push({
        tradier_position: {
          symbol: pos.symbol,
          underlying: parsed.underlying,
          expiration: parsed.expiration,
          strike: parsed.strike,
          type: parsed.type,
          quantity: pos.quantity,
          cost_basis: pos.cost_basis,
          market_value: pos.market_value,
        },
        in_portfolio_positions: !!portfolioMatch,
        portfolio_quantity: portfolioMatch?.quantity || null,
        matched_trade: matchedTrade ? {
          id: matchedTrade.id,
          symbol: matchedTrade.symbol,
          strategy: matchedTrade.strategy,
          short_strike: matchedTrade.short_strike,
          long_strike: matchedTrade.long_strike,
          expiration: matchedTrade.expiration,
          quantity: matchedTrade.quantity,
          status: matchedTrade.status,
        } : null,
        is_monitored: !!matchedTrade && matchedTrade.status === 'OPEN',
      });
    }
    
    // Summary
    const summary = {
      total_tradier_positions: optionPositions.length,
      positions_in_portfolio: positionAnalysis.filter(p => p.in_portfolio_positions).length,
      positions_with_trades: positionAnalysis.filter(p => p.matched_trade).length,
      positions_being_monitored: positionAnalysis.filter(p => p.is_monitored).length,
      positions_not_monitored: positionAnalysis.filter(p => !p.is_monitored).map(p => ({
        symbol: p.tradier_position.symbol,
        quantity: p.tradier_position.quantity,
      })),
    };
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        summary,
        open_trades_count: openTrades.length,
        open_trades: openTrades.map(t => ({
          id: t.id,
          symbol: t.symbol,
          strategy: t.strategy,
          short_strike: t.short_strike,
          long_strike: t.long_strike,
          expiration: t.expiration,
          quantity: t.quantity,
        })),
        position_analysis: positionAnalysis,
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

