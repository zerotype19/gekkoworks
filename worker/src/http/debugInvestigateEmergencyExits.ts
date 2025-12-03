/**
 * Debug endpoint to investigate EMERGENCY exits and expired/cancelled orders
 * Analyzes trades that had EMERGENCY exits and their order status
 */

import type { Env } from '../env';
import { getAllTrades, getTrade } from '../db/queries';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugInvestigateEmergencyExits(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const dateParam = url.searchParams.get('date') || '2025-12-01';
    
    // Get all trades closed on the specified date with EMERGENCY exit reason
    const allTrades = await getAllTrades(env, 1000);
    const emergencyTrades = allTrades.filter(t => 
      t.exit_reason === 'EMERGENCY' &&
      t.closed_at &&
      t.closed_at.split('T')[0] === dateParam
    );
    
    const broker = new TradierClient(env);
    const results: Array<{
      tradeId: string;
      symbol: string;
      strategy: string;
      openedAt: string;
      closedAt: string;
      durationMinutes: number;
      entryPrice: number | null;
      exitPrice: number | null;
      brokerOrderIdOpen: string | null;
      brokerOrderIdClose: string | null;
      openOrderStatus?: string;
      closeOrderStatus?: string;
      closeOrderRejectReason?: string;
      positionsAlreadyFlat?: boolean;
      structuralIntegrityIssue?: string;
      analysis: string[];
    }> = [];
    
    for (const trade of emergencyTrades) {
      const analysis: string[] = [];
      let openOrderStatus: string | undefined;
      let closeOrderStatus: string | undefined;
      let closeOrderRejectReason: string | undefined;
      let positionsAlreadyFlat: boolean | undefined;
      
      // Calculate duration
      const openedAt = new Date(trade.opened_at || trade.created_at);
      const closedAt = new Date(trade.closed_at!);
      const durationMinutes = Math.round((closedAt.getTime() - openedAt.getTime()) / (1000 * 60));
      
      // Check entry order status
      if (trade.broker_order_id_open) {
        try {
          const openOrder = await broker.getOrderWithLegs(trade.broker_order_id_open);
          openOrderStatus = openOrder.status;
          if (openOrderStatus !== 'FILLED') {
            analysis.push(`Entry order status: ${openOrderStatus} (should be FILLED)`);
          }
        } catch (err) {
          analysis.push(`Could not fetch entry order: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      } else {
        analysis.push('No broker_order_id_open - trade may have been created manually');
      }
      
      // Check exit order status and details
      if (trade.broker_order_id_close) {
        try {
          const closeOrder = await broker.getOrderWithLegs(trade.broker_order_id_close);
          closeOrderStatus = closeOrder.status;
          
          // Get reject reason if rejected/cancelled
          if (closeOrderStatus === 'REJECTED' || closeOrderStatus === 'CANCELLED' || closeOrderStatus === 'EXPIRED') {
            const reasonDesc = (closeOrder as any).reason_description || '';
            const legReasons = ((closeOrder as any).leg || [])
              .map((l: any) => l.reason_description || '')
              .filter((r: string) => r.length > 0)
              .join(', ');
            closeOrderRejectReason = `${reasonDesc}${legReasons ? ` | Legs: ${legReasons}` : ''}`;
            
            if (closeOrderStatus === 'EXPIRED') {
              analysis.push(`Exit order EXPIRED - likely market was closed or order timed out`);
            } else if (closeOrderStatus === 'CANCELLED') {
              analysis.push(`Exit order CANCELLED - may have been cancelled by broker or system`);
            } else if (closeOrderStatus === 'REJECTED') {
              analysis.push(`Exit order REJECTED: ${closeOrderRejectReason}`);
              
              // Check if it's a quantity mismatch (positions already flat)
              if (closeOrderRejectReason.toLowerCase().includes('more shares than your current') ||
                  closeOrderRejectReason.toLowerCase().includes('current position quantity')) {
                positionsAlreadyFlat = true;
                analysis.push('REJECTION REASON: Positions already flat at broker (quantity mismatch)');
              }
            }
          } else if (closeOrderStatus === 'FILLED') {
            analysis.push(`Exit order FILLED - should have exit_price (current: ${trade.exit_price || 'NULL'})`);
            if (!trade.exit_price) {
              analysis.push('ISSUE: Exit order filled but exit_price is NULL - backfill needed');
            }
          }
        } catch (err) {
          analysis.push(`Could not fetch exit order: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      } else {
        analysis.push('No broker_order_id_close - trade closed without placing exit order?');
      }
      
      // Analyze duration
      if (durationMinutes < 5) {
        analysis.push(`TRADE CLOSED VERY QUICKLY: ${durationMinutes} minutes after opening`);
        analysis.push('Possible causes: Structural integrity failure, positions already flat, or immediate exit trigger');
      } else if (durationMinutes < 60) {
        analysis.push(`Trade closed quickly: ${durationMinutes} minutes after opening`);
      }
      
      // Check if positions might have been already flat
      if (!trade.exit_price && !closeOrderStatus) {
        analysis.push('No exit_price and could not check order status - positions may have been already flat');
      }
      
      // Check entry order timing
      if (trade.broker_order_id_open && openOrderStatus === 'FILLED') {
        try {
          const openOrder = await broker.getOrderWithLegs(trade.broker_order_id_open);
          const orderFilledTime = openOrder.updated_at ? new Date(openOrder.updated_at) : null;
          if (orderFilledTime && closedAt) {
            const timeBetweenFillAndClose = Math.round((closedAt.getTime() - orderFilledTime.getTime()) / (1000 * 60));
            if (timeBetweenFillAndClose < 5) {
              analysis.push(`Trade closed ${timeBetweenFillAndClose} minutes after entry order filled - very suspicious`);
            }
          }
        } catch (err) {
          // Ignore errors fetching order details
        }
      }
      
      results.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        strategy: trade.strategy || 'UNKNOWN',
        openedAt: trade.opened_at || trade.created_at,
        closedAt: trade.closed_at!,
        durationMinutes,
        entryPrice: trade.entry_price,
        exitPrice: trade.exit_price,
        brokerOrderIdOpen: trade.broker_order_id_open,
        brokerOrderIdClose: trade.broker_order_id_close,
        openOrderStatus,
        closeOrderStatus,
        closeOrderRejectReason,
        positionsAlreadyFlat,
        analysis,
      });
    }
    
    // Also check for expired/cancelled orders on closed trades
    const tradesWithExpiredOrders = allTrades.filter(t =>
      t.status === 'CLOSED' &&
      t.broker_order_id_close &&
      (!t.exit_price || t.exit_price === null) &&
      t.closed_at &&
      t.closed_at.split('T')[0] === dateParam
    );
    
    const expiredOrderAnalysis: Array<{
      tradeId: string;
      symbol: string;
      exitReason: string | null;
      brokerOrderIdClose: string;
      orderStatus?: string;
      orderRejectReason?: string;
      analysis: string[];
    }> = [];
    
    for (const trade of tradesWithExpiredOrders) {
      const analysis: string[] = [];
      
      if (trade.broker_order_id_close) {
        try {
          const order = await broker.getOrderWithLegs(trade.broker_order_id_close);
          const orderStatus = order.status;
          analysis.push(`Exit order status: ${orderStatus}`);
          
          if (orderStatus === 'EXPIRED') {
            analysis.push('Order EXPIRED - likely never filled because:');
            analysis.push('  - Market was closed');
            analysis.push('  - Order expired before filling');
            analysis.push('  - Positions were already closed (already flat)');
          } else if (orderStatus === 'CANCELLED') {
            analysis.push('Order CANCELLED - likely because:');
            analysis.push('  - Positions were already flat');
            analysis.push('  - Manual cancellation');
            analysis.push('  - System cancelled due to error');
            
            const reasonDesc = (order as any).reason_description || '';
            if (reasonDesc) {
              analysis.push(`  - Reason: ${reasonDesc}`);
            }
          }
        } catch (err) {
          analysis.push(`Could not fetch order: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }
      
      expiredOrderAnalysis.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        exitReason: trade.exit_reason,
        brokerOrderIdClose: trade.broker_order_id_close!,
        analysis,
      });
    }
    
    return new Response(
      JSON.stringify({
        date: dateParam,
        timestamp: new Date().toISOString(),
        emergencyExits: {
          count: emergencyTrades.length,
          trades: results,
        },
        expiredCancelledOrders: {
          count: tradesWithExpiredOrders.length,
          trades: expiredOrderAnalysis,
        },
        summary: {
          totalEmergencyExits: emergencyTrades.length,
          tradesClosedQuickly: results.filter(r => r.durationMinutes < 5).length,
          tradesWithExpiredOrders: tradesWithExpiredOrders.length,
          tradesWithCancelledOrders: expiredOrderAnalysis.filter(t => t.orderStatus === 'CANCELLED').length,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
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

