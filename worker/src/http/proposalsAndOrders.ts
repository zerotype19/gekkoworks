/**
 * Proposals and Orders Endpoint
 * 
 * Returns proposals with their associated orders and broker responses,
 * including rationale for fills/rejections.
 */

import type { Env } from '../env';
import { getRecentProposals, getRecentBrokerEvents, getAllTrades, getProposal, getOrdersByProposalId } from '../db/queries';
import { getStrategyThresholds } from '../core/config';

export async function handleProposalsAndOrders(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    // Get recent proposals
    const proposals = await getRecentProposals(env, limit);

    // Get all trades to match proposals to trades
    const allTrades = await getAllTrades(env, 1000);

    // Get broker events (orders)
    const brokerEvents = await getRecentBrokerEvents(env, 500);

    // Get system logs for entry/exit rationale
    const { getRecentSystemLogs } = await import('../db/queries');
    const systemLogs = await getRecentSystemLogs(env, 1000);

    // Get current thresholds for context
    const thresholds = await getStrategyThresholds(env);

    // Build a map of proposal_id -> trade (direct link)
    const proposalToTrade = new Map<string, typeof allTrades[0]>();
    for (const trade of allTrades) {
      if (trade.proposal_id) {
        proposalToTrade.set(trade.proposal_id, trade);
      }
    }
    
    // Also build a map by symbol/strikes/expiration/strategy for trades without proposal_id
    // (created by portfolioSync - these should still be linked to matching proposals)
    const tradeKeyToTrade = new Map<string, typeof allTrades[0]>();
    for (const trade of allTrades) {
      if (!trade.proposal_id) {
        // Create a key: symbol-expiration-short_strike-long_strike-strategy
        // CRITICAL: Include strategy to avoid matching wrong trades (e.g., BULL_CALL_DEBIT vs BULL_PUT_CREDIT)
        const strategy = trade.strategy || 'BULL_PUT_CREDIT';
        const key = `${trade.symbol}-${trade.expiration}-${trade.short_strike}-${trade.long_strike}-${strategy}`;
        // Only add if we don't already have a trade for this key (prefer the most recent)
        if (!tradeKeyToTrade.has(key)) {
          tradeKeyToTrade.set(key, trade);
        } else {
          // If we have multiple trades for same key, prefer the one with a broker_order_id_open
          const existing = tradeKeyToTrade.get(key)!;
          if (trade.broker_order_id_open && !existing.broker_order_id_open) {
            tradeKeyToTrade.set(key, trade);
          }
        }
      }
    }

    // Build a map of order_id -> broker events
    const orderIdToEvents = new Map<string, typeof brokerEvents>();
    for (const event of brokerEvents) {
      if (event.order_id) {
        if (!orderIdToEvents.has(event.order_id)) {
          orderIdToEvents.set(event.order_id, []);
        }
        orderIdToEvents.get(event.order_id)!.push(event);
      }
    }

    // Extract entry/exit logs for rationale
    const entryLogs = systemLogs.filter(log => 
      log.message.includes('[entry]') || 
      log.message.includes('[auto][skip]') ||
      log.message.includes('[trade] lifecycle')
    );
    
    const exitLogs = systemLogs.filter(log => 
      log.message.includes('[exit]') ||
      log.message.includes('[monitor][exit]')
    );

    // Format proposals with their orders and rationale
    const formattedProposals = await Promise.all(proposals.map(async (proposal) => {
      // Get orders for this proposal from the orders table (source of truth)
      const orders = await getOrdersByProposalId(env, proposal.id);
      
      // Find entry and exit orders
      const entryOrder = orders.find(o => o.side === 'ENTRY');
      const exitOrder = orders.find(o => o.side === 'EXIT');
      
      // Get linked trade (from proposal.linked_trade_id for exits, or from entry order for entries)
      // CRITICAL: Always validate strategy matches to prevent showing wrong trades
      const proposalStrategy = proposal.strategy || 'BULL_PUT_CREDIT';
      let trade = null;
      if (proposal.kind === 'EXIT' && proposal.linked_trade_id) {
        const candidateTrade = allTrades.find(t => t.id === proposal.linked_trade_id) || null;
        // Validate strategy matches
        if (candidateTrade && (candidateTrade.strategy || 'BULL_PUT_CREDIT') === proposalStrategy) {
          trade = candidateTrade;
        }
      } else if (entryOrder && entryOrder.trade_id) {
        const candidateTrade = allTrades.find(t => t.id === entryOrder.trade_id) || null;
        // Validate strategy matches
        if (candidateTrade && (candidateTrade.strategy || 'BULL_PUT_CREDIT') === proposalStrategy) {
          trade = candidateTrade;
        }
      } else {
        // Fallback: try direct proposal_id match
        const candidateTrade = proposalToTrade.get(proposal.id);
        // Validate strategy matches
        if (candidateTrade && (candidateTrade.strategy || 'BULL_PUT_CREDIT') === proposalStrategy) {
          trade = candidateTrade;
        }
        
        // If no direct match, try matching by symbol/strikes/expiration/strategy
        // CRITICAL: Include strategy to avoid matching wrong trades (e.g., BULL_CALL_DEBIT vs BULL_PUT_CREDIT)
        if (!trade) {
          const tradeKey = `${proposal.symbol}-${proposal.expiration}-${proposal.short_strike}-${proposal.long_strike}-${proposalStrategy}`;
          const matchedTrade = tradeKeyToTrade.get(tradeKey);
          if (matchedTrade) {
            trade = matchedTrade;
          }
        }
      }
      
      // Find broker events for this proposal's trade (for backward compatibility)
      const entryOrderEvents: typeof brokerEvents = [];
      const exitOrderEvents: typeof brokerEvents = [];
      
      if (trade) {
        if (trade.broker_order_id_open) {
          const events = orderIdToEvents.get(trade.broker_order_id_open) || [];
          entryOrderEvents.push(...events);
        }
        if (trade.broker_order_id_close) {
          const events = orderIdToEvents.get(trade.broker_order_id_close) || [];
          exitOrderEvents.push(...events);
        }
      }

      // Find relevant system logs for this proposal
      const proposalEntryLogs = entryLogs.filter(log => {
        try {
          const details = log.details ? JSON.parse(log.details) : {};
          return details.proposal_id === proposal.id || 
                 (trade && details.trade_id === trade.id);
        } catch {
          return false;
        }
      });

      const proposalExitLogs = trade ? exitLogs.filter(log => {
        try {
          const details = log.details ? JSON.parse(log.details) : {};
          return details.trade_id === trade.id;
        } catch {
          return false;
        }
      }) : [];

      // Determine proposal outcome
      let outcome: 'PENDING' | 'FILLED' | 'REJECTED' | 'INVALIDATED' | 'NOT_ATTEMPTED' = 'NOT_ATTEMPTED';
      let outcomeReason = '';
      
      if (proposal.status === 'INVALIDATED') {
        outcome = 'INVALIDATED';
        outcomeReason = 'Proposal invalidated before entry attempt';
      } else if (proposal.status === 'CONSUMED' && trade) {
        if (trade.status === 'OPEN' || trade.status === 'CLOSING_PENDING') {
          outcome = 'FILLED';
          outcomeReason = 'Order filled successfully';
        } else if (trade.status === 'CLOSED') {
          outcome = 'FILLED';
          outcomeReason = 'Order filled and trade closed';
        } else if (trade.status === 'CANCELLED' || trade.status === 'CLOSE_FAILED' || trade.status === 'EXIT_ERROR') {
          outcome = 'REJECTED';
          outcomeReason = trade.exit_reason || 'Order cancelled or failed';
        } else if (trade.status === 'ENTRY_PENDING') {
          outcome = 'PENDING';
          outcomeReason = 'Order pending fill';
        } else {
          // CONSUMED but trade has unexpected status
          outcome = 'FILLED';
          outcomeReason = `Trade exists with status: ${trade.status}`;
        }
      } else if (proposal.status === 'CONSUMED' && !trade) {
        // Proposal was CONSUMED but no trade found (shouldn't happen, but handle gracefully)
        outcome = 'NOT_ATTEMPTED';
        outcomeReason = 'Proposal marked CONSUMED but no matching trade found';
      } else if (proposal.status === 'READY') {
        // Check if there's a matching trade even though proposal is still READY
        // (could happen if portfolioSync created trade before entry.ts processed proposal)
        if (trade) {
          outcome = 'FILLED';
          outcomeReason = 'Trade exists (likely created by portfolioSync) but proposal still marked READY';
        } else {
          outcome = 'PENDING';
          outcomeReason = 'Proposal ready but not yet attempted';
        }
      } else if (trade) {
        // Trade exists but proposal status is unexpected - still show as FILLED
        outcome = 'FILLED';
        outcomeReason = `Trade exists but proposal status is ${proposal.status}`;
      }

      // Extract rejection reasons from logs
      const rejectionReasons: string[] = [];
      for (const log of proposalEntryLogs) {
        if (log.message.includes('[auto][skip]')) {
          try {
            const details = log.details ? JSON.parse(log.details) : {};
            if (details.reason) {
              rejectionReasons.push(details.reason);
            }
          } catch {}
        }
        if (log.message.includes('[entry] attemptEntryForLatestProposal error')) {
          try {
            const details = log.details ? JSON.parse(log.details) : {};
            if (details.error) {
              rejectionReasons.push(details.error);
            }
          } catch {}
        }
      }

      // Determine lifecycle status from order
      let lifecycleStatus = 'No order placed';
      if (entryOrder) {
        if (entryOrder.status === 'PENDING' || entryOrder.status === 'PLACED') {
          lifecycleStatus = 'Order sent – waiting';
        } else if (entryOrder.status === 'FILLED') {
          lifecycleStatus = trade && trade.status === 'OPEN' 
            ? 'Entry filled – trade OPEN'
            : 'Entry filled';
        } else if (entryOrder.status === 'CANCELLED' || entryOrder.status === 'REJECTED') {
          lifecycleStatus = `Entry ${entryOrder.status.toLowerCase()}`;
        }
      } else if (exitOrder) {
        if (exitOrder.status === 'PENDING' || exitOrder.status === 'PLACED') {
          lifecycleStatus = 'Exit order sent – waiting';
        } else if (exitOrder.status === 'FILLED') {
          lifecycleStatus = trade && trade.status === 'CLOSED'
            ? 'Exit filled – trade CLOSED'
            : 'Exit filled';
        } else if (exitOrder.status === 'CANCELLED' || exitOrder.status === 'REJECTED') {
          lifecycleStatus = `Exit ${exitOrder.status.toLowerCase()}`;
        }
      }

      // Get broker response details (for backward compatibility)
      const entryOrderResponse = entryOrderEvents.find(e => e.operation === 'PLACE_ORDER');
      const entryOrderStatus = entryOrderEvents.find(e => e.operation === 'GET_ORDER');

      return {
        proposal: {
          id: proposal.id,
          symbol: proposal.symbol,
          expiration: proposal.expiration,
          short_strike: proposal.short_strike,
          long_strike: proposal.long_strike,
          width: proposal.width,
          quantity: proposal.quantity,
          strategy: proposal.strategy || 'BULL_PUT_CREDIT',
          credit_target: proposal.credit_target,
          score: proposal.score,
          status: proposal.status,
          created_at: proposal.created_at,
          // Component scores
          ivr_score: proposal.ivr_score,
          vertical_skew_score: proposal.vertical_skew_score,
          term_structure_score: proposal.term_structure_score,
          delta_fitness_score: proposal.delta_fitness_score,
          ev_score: proposal.ev_score,
          // Thresholds
          min_score_required: thresholds.minScore,
          min_credit_required: proposal.width * thresholds.minCreditFraction,
          // New fields
          proposalKind: proposal.kind || (proposal.linked_trade_id ? 'EXIT' : 'ENTRY'),
        },
        trade: trade ? {
          id: trade.id,
          status: trade.status,
          strategy: trade.strategy || null,
          entry_price: trade.entry_price,
          exit_price: trade.exit_price,
          opened_at: trade.opened_at,
          closed_at: trade.closed_at,
          broker_order_id_open: trade.broker_order_id_open,
          broker_order_id_close: trade.broker_order_id_close,
        } : null,
        order: entryOrder || exitOrder ? {
          status: (entryOrder || exitOrder)!.status,
          side: (entryOrder || exitOrder)!.side,
          avgFillPrice: (entryOrder || exitOrder)!.avg_fill_price,
          tradierOrderId: (entryOrder || exitOrder)!.tradier_order_id,
          clientOrderId: (entryOrder || exitOrder)!.client_order_id,
        } : null,
        lifecycleStatus,
        outcome,
        outcomeReason,
        rejectionReasons,
        entryOrder: entryOrderResponse ? {
          order_id: entryOrderResponse.order_id,
          status_code: entryOrderResponse.status_code,
          ok: entryOrderResponse.ok,
          error_message: entryOrderResponse.error_message,
          created_at: entryOrderResponse.created_at,
          duration_ms: entryOrderResponse.duration_ms,
        } : null,
        entryOrderStatus: entryOrderStatus ? {
          order_id: entryOrderStatus.order_id,
          status_code: entryOrderStatus.status_code,
          ok: entryOrderStatus.ok,
          error_message: entryOrderStatus.error_message,
          created_at: entryOrderStatus.created_at,
        } : null,
        exitOrder: exitOrderEvents.find(e => e.operation === 'PLACE_ORDER') ? {
          order_id: exitOrderEvents.find(e => e.operation === 'PLACE_ORDER')!.order_id,
          status_code: exitOrderEvents.find(e => e.operation === 'PLACE_ORDER')!.status_code,
          ok: exitOrderEvents.find(e => e.operation === 'PLACE_ORDER')!.ok,
          error_message: exitOrderEvents.find(e => e.operation === 'PLACE_ORDER')!.error_message,
          created_at: exitOrderEvents.find(e => e.operation === 'PLACE_ORDER')!.created_at,
        } : null,
        entryLogs: proposalEntryLogs.slice(0, 10).map(log => ({
          created_at: log.created_at,
          message: log.message,
          details: log.details,
        })),
        exitLogs: proposalExitLogs.slice(0, 10).map(log => ({
          created_at: log.created_at,
          message: log.message,
          details: log.details,
        })),
      };
    }));

    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        proposals: formattedProposals,
        summary: {
          total: formattedProposals.length,
          filled: formattedProposals.filter(p => p.outcome === 'FILLED').length,
          rejected: formattedProposals.filter(p => p.outcome === 'REJECTED').length,
          pending: formattedProposals.filter(p => p.outcome === 'PENDING').length,
          invalidated: formattedProposals.filter(p => p.outcome === 'INVALIDATED').length,
          not_attempted: formattedProposals.filter(p => p.outcome === 'NOT_ATTEMPTED').length,
        },
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

