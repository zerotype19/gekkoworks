/**
 * Debug endpoint to analyze order placement status
 * Shows which proposals are being submitted as orders and their outcomes
 */

import type { Env } from '../env';
import { getRecentBrokerEvents, getRecentSystemLogs, getRecentProposals } from '../db/queries';
import { getAllTrades } from '../db/queries';

export async function handleDebugOrderStatus(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    // Get recent data
    const brokerEvents = await getRecentBrokerEvents(env, limit * 2);
    const systemLogs = await getRecentSystemLogs(env, limit * 2);
    const proposals = await getRecentProposals(env, limit);
    const trades = await getAllTrades(env, limit);

    // Filter PLACE_ORDER events
    const placeOrderEvents = brokerEvents.filter(e => e.operation === 'PLACE_ORDER');
    
    // Filter entry-related system logs
    const entryLogs = systemLogs.filter(log => 
      log.message.includes('[entry]') || 
      log.message.includes('[broker][placeSpreadOrder]')
    );

    // Analyze by strategy
    const byStrategy: Record<string, {
      proposals: number;
      orderAttempts: number;
      successful: number;
      failed: number;
      rejected: number;
      errors: Array<{ timestamp: string; error: string; strategy?: string }>;
    }> = {};

    // Initialize strategies
    ['BEAR_PUT_DEBIT', 'BULL_CALL_DEBIT', 'BULL_PUT_CREDIT', 'BEAR_CALL_CREDIT'].forEach(strategy => {
      byStrategy[strategy] = {
        proposals: 0,
        orderAttempts: 0,
        successful: 0,
        failed: 0,
        rejected: 0,
        errors: [],
      };
    });

    // Count proposals by strategy
    proposals.forEach(proposal => {
      const strategy = proposal.strategy || 'UNKNOWN';
      if (byStrategy[strategy]) {
        byStrategy[strategy].proposals++;
      }
    });

    // Analyze broker events
    placeOrderEvents.forEach(event => {
      // Try to extract strategy from system logs
      const relatedLogs = entryLogs.filter(log => {
        try {
          const details = log.details ? JSON.parse(log.details) : {};
          return details.strategy || details.symbol === event.symbol;
        } catch {
          return false;
        }
      });

      // Try to get strategy from broker event first (most reliable)
      let strategy = event.strategy || 'UNKNOWN';
      
      // Fallback to system logs if not in broker event
      if (strategy === 'UNKNOWN' && relatedLogs.length > 0) {
        try {
          const details = JSON.parse(relatedLogs[0].details || '{}');
          strategy = details.strategy || 'UNKNOWN';
        } catch {}
      }

      if (byStrategy[strategy]) {
        byStrategy[strategy].orderAttempts++;
        
        if (event.ok) {
          byStrategy[strategy].successful++;
        } else {
          byStrategy[strategy].failed++;
          if (event.error_message) {
            byStrategy[strategy].errors.push({
              timestamp: event.created_at,
              error: event.error_message,
              strategy,
            });
          }
        }
      }
    });

    // Check for Tradier rejections in system logs
    const rejectionLogs = systemLogs.filter(log => 
      log.message.includes('[entry][rejected]') ||
      log.message.includes('[broker][placeSpreadOrder][error]') ||
      log.message.includes('Tradier API error')
    );

    rejectionLogs.forEach(log => {
      try {
        const details = log.details ? JSON.parse(log.details) : {};
        const strategy = details.strategy || 'UNKNOWN';
        
        if (byStrategy[strategy]) {
          byStrategy[strategy].rejected++;
          if (details.error_message || details.reason || log.message) {
            byStrategy[strategy].errors.push({
              timestamp: log.created_at,
              error: details.error_message || details.reason || log.message,
              strategy,
            });
          }
        }
      } catch {}
    });

    // Get all broker events for order tracking
    const orderStatusEvents = brokerEvents.filter(e => 
      e.operation === 'GET_ORDER_STATUS' || e.operation === 'GET_ORDER_WITH_LEGS'
    );
    const cancelOrderEvents = brokerEvents.filter(e => e.operation === 'CANCEL_ORDER');

    // Find debug logs for order placement (full API request/response)
    // Note: These may not be in system_logs if they're only console.log
    const placeOrderDebugLogs = systemLogs.filter(log => 
      log.message.includes('[broker][placeSpreadOrder][debug]') ||
      log.message.includes('[entry] placing order')
    );
    const placeOrderErrorLogs = systemLogs.filter(log => 
      log.message.includes('[broker][placeSpreadOrder][error]') ||
      log.message.includes('[entry][rejected]') ||
      log.message.includes('[entry] order cancelled')
    );

    // Get recent order events with full API details
    const recentOrderEvents = placeOrderEvents.slice(0, 20).map(event => {
      // Find related entry logs
      const relatedEntryLogs = entryLogs.filter(log => {
        try {
          const details = log.details ? JSON.parse(log.details) : {};
          return details.orderId === event.order_id || 
                 (details.symbol === event.symbol && 
                  Math.abs(new Date(log.created_at).getTime() - new Date(event.created_at).getTime()) < 5000);
        } catch {
          return false;
        }
      });

      // Find debug log with full API request details
      // First try to find by order_id (most reliable)
      let debugLog = placeOrderDebugLogs.find(log => {
        try {
          const details = log.details ? JSON.parse(log.details) : {};
          if (event.order_id && details.orderId === event.order_id) return true;
          return false;
        } catch {
          return false;
        }
      });
      
      // If not found by order_id, try timestamp proximity
      if (!debugLog) {
        debugLog = placeOrderDebugLogs.find(log => {
          try {
            const logTime = new Date(log.created_at).getTime();
            const eventTime = new Date(event.created_at).getTime();
            return Math.abs(logTime - eventTime) < 2000; // Within 2 seconds
          } catch {
            return false;
          }
        });
      }

      // Find error log if order failed
      const errorLog = placeOrderErrorLogs.find(log => {
        try {
          const logTime = new Date(log.created_at).getTime();
          const eventTime = new Date(event.created_at).getTime();
          return Math.abs(logTime - eventTime) < 2000;
        } catch {
          return false;
        }
      });

      // Find all order status checks for this order
      const statusChecks = orderStatusEvents
        .filter(e => e.order_id === event.order_id)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map(e => ({
          timestamp: e.created_at,
          status_code: e.status_code,
          ok: e.ok,
          error_message: e.error_message,
          duration_ms: e.duration_ms,
        }));

      // Find cancel event if order was cancelled
      const cancelEvent = cancelOrderEvents.find(e => e.order_id === event.order_id);

      // Try to get strategy from broker event first (most reliable)
      let strategy = event.strategy || 'UNKNOWN';
      let limitPrice: number | null = null;
      let apiRequest: any = null;
      let apiResponse: any = null;
      
      // Fallback to system logs if not in broker event
      if (strategy === 'UNKNOWN' && relatedEntryLogs.length > 0) {
        try {
          const details = JSON.parse(relatedEntryLogs[0].details || '{}');
          strategy = details.strategy || 'UNKNOWN';
          limitPrice = details.limit_price || null;
        } catch {}
      }

      // Extract full API request/response from debug log or entry log
      if (debugLog) {
        try {
          // Try parsing from details field first
          let debugDetails: any = {};
          if (debugLog.details) {
            debugDetails = JSON.parse(debugLog.details);
          } else if (debugLog.message.includes('[entry] placing order')) {
            // Try to extract from message if it's a JSON string
            const jsonMatch = debugLog.message.match(/\{.*\}/);
            if (jsonMatch) {
              debugDetails = JSON.parse(jsonMatch[0]);
            }
          }
          
          // Build API request from available data
          apiRequest = {
            url: `/accounts/{account_id}/orders`,
            method: 'POST',
            strategy: debugDetails.strategy || strategy,
            side: debugDetails.side || (debugDetails.is_debit_spread ? 'ENTRY' : 'ENTRY'),
            orderType: debugDetails.orderType || (debugDetails.is_debit_spread ? 'debit' : 'credit'),
            isExit: debugDetails.isExit || false,
            limit_price: debugDetails.limit_price || limitPrice,
            symbol: debugDetails.symbol || event.symbol,
            expiration: debugDetails.expiration || null,
            short_strike: debugDetails.short_strike || null,
            long_strike: debugDetails.long_strike || null,
            legs: debugDetails.leg0 && debugDetails.leg1 ? [
              {
                option_symbol: debugDetails.leg0.option_symbol,
                side: debugDetails.leg0.side,
                quantity: debugDetails.leg0.quantity,
              },
              {
                option_symbol: debugDetails.leg1.option_symbol,
                side: debugDetails.leg1.side,
                quantity: debugDetails.leg1.quantity,
              },
            ] : (debugDetails.short_option_symbol && debugDetails.long_option_symbol ? [
              {
                option_symbol: debugDetails.long_option_symbol,
                side: debugDetails.is_debit_spread ? 'buy_to_open' : 'sell_to_open',
                quantity: 1,
              },
              {
                option_symbol: debugDetails.short_option_symbol,
                side: debugDetails.is_debit_spread ? 'sell_to_open' : 'buy_to_open',
                quantity: 1,
              },
            ] : null),
            body_entries: debugDetails.bodyEntries || null,
            body_string: debugDetails.bodyString || null,
          };
          apiResponse = {
            order_id: event.order_id,
            status_code: event.status_code,
            ok: event.ok,
            timestamp: event.created_at,
            duration_ms: event.duration_ms,
          };
        } catch (e) {
          // If parsing fails, at least include the raw log
          apiRequest = {
            raw_log_message: debugLog.message,
            raw_log_details: debugLog.details,
          };
        }
      }

      // Extract error details if order failed
      if (errorLog) {
        try {
          const errorDetails = JSON.parse(errorLog.details || '{}');
          if (!apiRequest) {
            apiRequest = {
              strategy: errorDetails.strategy,
              side: errorDetails.side,
              limit_price: errorDetails.limit_price,
              legs: errorDetails.legs || null,
            };
          }
          apiResponse = {
            ...apiResponse,
            error: {
              message: errorDetails.error_message || event.error_message,
              type: errorDetails.error_type,
              stack: errorDetails.error_stack,
            },
          };
        } catch {}
      }

      return {
        timestamp: event.created_at,
        order_id: event.order_id,
        symbol: event.symbol,
        strategy,
        status_code: event.status_code,
        ok: event.ok,
        error_message: event.error_message,
        limit_price: limitPrice,
        duration_ms: event.duration_ms,
        api_request: apiRequest,
        api_response: apiResponse,
        status_checks: statusChecks.length > 0 ? statusChecks : undefined,
        cancelled: cancelEvent ? {
          timestamp: cancelEvent.created_at,
          status_code: cancelEvent.status_code,
          ok: cancelEvent.ok,
          error_message: cancelEvent.error_message,
        } : undefined,
      };
    });

    // Build detailed order lifecycle for each order
    const orderLifecycles = placeOrderEvents.slice(0, 20).map(event => {
      const lifecycle: any = {
        order_id: event.order_id,
        symbol: event.symbol,
        created_at: event.created_at,
        initial_status: event.ok ? 'SUBMITTED' : 'FAILED',
        initial_status_code: event.status_code,
        initial_error: event.error_message || null,
      };

      // Find all status checks
      const statusChecks = orderStatusEvents
        .filter(e => e.order_id === event.order_id)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      
      lifecycle.status_progression = statusChecks.map(e => ({
        timestamp: e.created_at,
        status_code: e.status_code,
        ok: e.ok,
        error_message: e.error_message,
        duration_ms: e.duration_ms,
      }));

      // Find cancel event
      const cancelEvent = cancelOrderEvents.find(e => e.order_id === event.order_id);
      if (cancelEvent) {
        lifecycle.cancelled = {
          timestamp: cancelEvent.created_at,
          status_code: cancelEvent.status_code,
          ok: cancelEvent.ok,
          error_message: cancelEvent.error_message,
        };
      }

      // Find related trade if exists
      const relatedTrade = trades.find(t => 
        t.broker_order_id_open === event.order_id || 
        t.broker_order_id_close === event.order_id
      );
      if (relatedTrade) {
        lifecycle.trade = {
          id: relatedTrade.id,
          status: relatedTrade.status,
          entry_price: relatedTrade.entry_price,
          exit_price: relatedTrade.exit_price,
          exit_reason: relatedTrade.exit_reason,
        };
      }

      return lifecycle;
    });

    // Summary
    const totalProposals = proposals.length;
    const totalOrderAttempts = placeOrderEvents.length;
    const totalSuccessful = placeOrderEvents.filter(e => e.ok).length;
    const totalFailed = placeOrderEvents.filter(e => !e.ok).length;

    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        summary: {
          total_proposals: totalProposals,
          total_order_attempts: totalOrderAttempts,
          total_successful: totalSuccessful,
          total_failed: totalFailed,
          success_rate: totalOrderAttempts > 0 ? (totalSuccessful / totalOrderAttempts * 100).toFixed(1) + '%' : '0%',
        },
        by_strategy: byStrategy,
        recent_order_events: recentOrderEvents,
        order_lifecycles: orderLifecycles,
        recent_rejections: rejectionLogs.slice(0, 10).map(log => ({
          timestamp: log.created_at,
          message: log.message,
          details: log.details,
        })),
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

