/**
 * Debug endpoint to backfill missing exit prices for closed trades
 * Queries Tradier for order details and updates exit_price and realized_pnl
 */

import type { Env } from '../env';
import { getAllTrades, getTrade, updateTrade } from '../db/queries';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugBackfillExitPrices(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tradeIdParam = url.searchParams.get('trade_id');
    
    // Get all closed trades missing exit prices
    const allTrades = await getAllTrades(env, 1000);
    const tradesNeedingBackfill = allTrades.filter(t => 
      t.status === 'CLOSED' && 
      t.broker_order_id_close && 
      (!t.exit_price || t.exit_price === null)
    );
    
    // Filter to specific trade if provided
    const tradesToFix = tradeIdParam 
      ? tradesNeedingBackfill.filter(t => t.id === tradeIdParam)
      : tradesNeedingBackfill;
    
    if (tradesToFix.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No trades need exit price backfill',
          checked: tradesNeedingBackfill.length,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    const broker = new TradierClient(env);
    const results: Array<{
      tradeId: string;
      success: boolean;
      exitPrice?: number;
      realizedPnl?: number;
      error?: string;
    }> = [];
    
    for (const trade of tradesToFix) {
      try {
        if (!trade.broker_order_id_close) {
          results.push({
            tradeId: trade.id,
            success: false,
            error: 'No broker_order_id_close',
          });
          continue;
        }
        
        if (!trade.entry_price || trade.entry_price <= 0) {
          results.push({
            tradeId: trade.id,
            success: false,
            error: 'Missing or invalid entry_price',
          });
          continue;
        }
        
        // Fetch order details with legs to get accurate fill price
        const orderDetails = await broker.getOrderWithLegs(trade.broker_order_id_close);
        
        // Check if order is filled (case-insensitive)
        const orderStatus = (orderDetails.status || '').toUpperCase();
        if (orderStatus !== 'FILLED') {
          results.push({
            tradeId: trade.id,
            success: false,
            error: `Order status is ${orderDetails.status}, not FILLED`,
          });
          continue;
        }
        
        // Calculate exit price from order details
        let exitPrice: number | null = null;
        
        if (orderDetails.avg_fill_price != null) {
          const rawPrice = parseFloat(orderDetails.avg_fill_price.toString());
          // For credit spreads, Tradier returns negative values - normalize to positive
          if (orderDetails.type === 'credit' && rawPrice < 0) {
            exitPrice = Math.abs(rawPrice);
          } else {
            exitPrice = rawPrice;
          }
        } else if (orderDetails.leg && Array.isArray(orderDetails.leg)) {
          // Calculate from leg prices
          const netPrice = orderDetails.leg.reduce((sum: number, leg: any) => {
            const legPrice = leg.avg_fill_price ? parseFloat(leg.avg_fill_price.toString()) : 0;
            if (leg.side?.includes('sell')) {
              return sum + legPrice; // Credit received
            } else if (leg.side?.includes('buy')) {
              return sum - legPrice; // Debit paid
            }
            return sum;
          }, 0);
          exitPrice = Math.abs(netPrice);
        }
        
        if (!exitPrice || exitPrice <= 0) {
          results.push({
            tradeId: trade.id,
            success: false,
            error: 'Could not calculate exit price from order details',
          });
          continue;
        }
        
        // Calculate realized_pnl
        const isDebitSpread = trade.strategy === 'BULL_CALL_DEBIT' || trade.strategy === 'BEAR_PUT_DEBIT';
        const quantity = trade.quantity ?? 1;
        let realized_pnl: number;
        
        if (isDebitSpread) {
          // Debit: PnL = (exit_price - entry_price) * quantity
          realized_pnl = (exitPrice - trade.entry_price) * quantity;
        } else {
          // Credit: PnL = (entry_price - exit_price) * quantity
          realized_pnl = (trade.entry_price - exitPrice) * quantity;
        }
        
        // Update the trade
        await updateTrade(env, trade.id, {
          exit_price: exitPrice,
          realized_pnl: realized_pnl,
        });
        
        results.push({
          tradeId: trade.id,
          success: true,
          exitPrice: exitPrice,
          realizedPnl: realized_pnl,
        });
      } catch (error) {
        results.push({
          tradeId: trade.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    return new Response(
      JSON.stringify({
        success: true,
        total: tradesToFix.length,
        fixed: successCount,
        failed: failCount,
        results,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
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

