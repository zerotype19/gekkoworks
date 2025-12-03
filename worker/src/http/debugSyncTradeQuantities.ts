/**
 * Debug endpoint to sync trade quantities from portfolio positions
 * This fixes the mismatch where trade.quantity doesn't match actual portfolio positions
 */

import type { Env } from '../env';
import { getOpenTrades, getSpreadLegPositions, updateTrade } from '../db/queries';
import { computeSpreadPositionSnapshot } from '../core/positions';

export async function handleDebugSyncTradeQuantities(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const dryRun = url.searchParams.get('dry_run') !== 'false'; // Default to true for safety
    
    const openTrades = await getOpenTrades(env);
    const results: any[] = [];
    let fixedCount = 0;
    
    for (const trade of openTrades) {
      if (!trade.strategy) {
        results.push({
          trade_id: trade.id,
          symbol: trade.symbol,
          error: 'Trade missing strategy - cannot determine option type',
        });
        continue;
      }
      
      const optionType = (trade.strategy === 'BEAR_CALL_CREDIT' || trade.strategy === 'BULL_CALL_DEBIT') ? 'call' : 'put';
      
      // Get spread leg positions from portfolio
      const { shortLeg, longLeg } = await getSpreadLegPositions(
        env,
        trade.symbol,
        trade.expiration,
        optionType,
        trade.short_strike,
        trade.long_strike
      );
      
      // Compute snapshot to get actual quantities
      const snapshot = computeSpreadPositionSnapshot(trade, shortLeg, longLeg);
      
      // Portfolio quantity is the minimum of short and long legs (spread quantity)
      const portfolioQuantity = Math.min(snapshot.shortQty, snapshot.longQty);
      
      // Check if trade quantity matches portfolio quantity
      if (trade.quantity !== portfolioQuantity) {
        const update = {
          trade_id: trade.id,
          symbol: trade.symbol,
          strategy: trade.strategy,
          current_trade_quantity: trade.quantity,
          portfolio_quantity: portfolioQuantity,
          short_leg_qty: snapshot.shortQty,
          long_leg_qty: snapshot.longQty,
          fixed: false,
        };
        
        if (!dryRun && portfolioQuantity > 0) {
          // Update trade quantity to match portfolio
          // Also update max_profit and max_loss proportionally
          const perContractMaxProfit = trade.max_profit && trade.quantity > 0
            ? trade.max_profit / trade.quantity
            : null;
          const perContractMaxLoss = trade.max_loss && trade.quantity > 0
            ? trade.max_loss / trade.quantity
            : null;
          
          await updateTrade(env, trade.id, {
            quantity: portfolioQuantity,
            max_profit: perContractMaxProfit !== null
              ? perContractMaxProfit * portfolioQuantity
              : trade.max_profit,
            max_loss: perContractMaxLoss !== null
              ? perContractMaxLoss * portfolioQuantity
              : trade.max_loss,
          });
          
          update.fixed = true;
          fixedCount++;
        }
        
        results.push(update);
      } else {
        results.push({
          trade_id: trade.id,
          symbol: trade.symbol,
          strategy: trade.strategy,
          current_trade_quantity: trade.quantity,
          portfolio_quantity: portfolioQuantity,
          status: 'already_synced',
        });
      }
    }
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        dry_run: dryRun,
        total_trades_checked: openTrades.length,
        trades_needing_sync: results.filter(r => !r.status && !r.error).length,
        trades_fixed: fixedCount,
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

