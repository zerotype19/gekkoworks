/**
 * Debug Backfill Entry Prices Endpoint
 * 
 * Backfills entry_price for trades that are missing it by:
 * 1. Looking up filled entry orders
 * 2. Calculating from cost_basis in Tradier positions
 * 3. Using portfolio sync calculation
 */

import type { Env } from '../env';
import { getOpenTrades, updateTrade } from '../db/queries';
import { TradierClient } from '../broker/tradierClient';
import { syncPortfolioFromTradier } from '../engine/portfolioSync';
import { syncOrdersFromTradier } from '../engine/orderSync';
import { getDefaultTradeQuantity } from '../core/config';

export async function handleDebugBackfillEntryPrices(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    // 1. Sync orders first to get latest fill prices
    console.log('[backfill] syncing orders...');
    await syncOrdersFromTradier(env);
    
    // 2. Sync portfolio to calculate entry_price from cost_basis
    console.log('[backfill] syncing portfolio...');
    await syncPortfolioFromTradier(env);
    
    // 3. Get all open trades missing entry_price
    const openTrades = await getOpenTrades(env);
    const tradesMissingEntryPrice = openTrades.filter(t => !t.entry_price || t.entry_price <= 0);
    
    console.log('[backfill] found trades missing entry_price', JSON.stringify({
      total_open: openTrades.length,
      missing_entry_price: tradesMissingEntryPrice.length,
    }));
    
    const results = {
      total_open: openTrades.length,
      missing_entry_price: tradesMissingEntryPrice.length,
      backfilled_from_orders: 0,
      backfilled_from_portfolio: 0,
      still_missing: 0,
      errors: [] as string[],
    };
    
    const broker = new TradierClient(env);
    const defaultQuantity = await getDefaultTradeQuantity(env);
    
    // 4. Try to backfill from filled orders
    for (const trade of tradesMissingEntryPrice) {
      if (trade.broker_order_id_open) {
        try {
          const order = await broker.getOrder(trade.broker_order_id_open);
          if (order.status === 'FILLED' && order.avg_fill_price !== null && order.avg_fill_price > 0) {
            const quantity = trade.quantity ?? defaultQuantity;
            const max_profit = order.avg_fill_price * quantity;
            const max_loss = (trade.width - order.avg_fill_price) * quantity;
            
            await updateTrade(env, trade.id, {
              entry_price: order.avg_fill_price,
              max_profit,
              max_loss,
            });
            
            results.backfilled_from_orders++;
            console.log('[backfill] backfilled from order', JSON.stringify({
              tradeId: trade.id,
              orderId: trade.broker_order_id_open,
              entry_price: order.avg_fill_price,
            }));
            continue;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          results.errors.push(`Failed to get order ${trade.broker_order_id_open}: ${errorMsg}`);
        }
      }
    }
    
    // 5. Re-sync portfolio to pick up any entry_price calculated from cost_basis
    await syncPortfolioFromTradier(env);
    
    // 6. Check again after portfolio sync
    const stillMissing = await getOpenTrades(env);
    const stillMissingEntryPrice = stillMissing.filter(t => 
      tradesMissingEntryPrice.some(mt => mt.id === t.id) && 
      (!t.entry_price || t.entry_price <= 0)
    );
    
    // Count how many were fixed by portfolio sync
    const fixedByPortfolio = tradesMissingEntryPrice.length - stillMissingEntryPrice.length - results.backfilled_from_orders;
    results.backfilled_from_portfolio = fixedByPortfolio;
    results.still_missing = stillMissingEntryPrice.length;
    
    return new Response(
      JSON.stringify({
        success: true,
        timestamp: now.toISOString(),
        results,
        still_missing_trades: stillMissingEntryPrice.map(t => ({
          id: t.id,
          symbol: t.symbol,
          expiration: t.expiration,
          broker_order_id_open: t.broker_order_id_open,
        })),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        success: false,
        error: errorMsg,
        timestamp: now.toISOString(),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

