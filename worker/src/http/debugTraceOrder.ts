/**
 * Debug endpoint to trace an order from proposal through fill to trade
 * 
 * Given a Tradier order ID, client_order_id, or proposal ID, traces the complete lifecycle
 */

import type { Env } from '../env';
import { getProposal, getTrade } from '../db/queries';
import { getDB } from '../db/client';

export async function handleDebugTraceOrder(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tradierOrderId = url.searchParams.get('tradier_order_id');
    const clientOrderId = url.searchParams.get('client_order_id');
    const proposalId = url.searchParams.get('proposal_id');
    const symbol = url.searchParams.get('symbol') || 'QQQ';
    const fillTime = url.searchParams.get('fill_time'); // e.g., "2025-12-03T09:47:01"
    
    // If no specific ID provided, try to find recent QQQ orders
    let traceResult: any = {
      timestamp: new Date().toISOString(),
      searchParams: {
        tradierOrderId,
        clientOrderId,
        proposalId,
        symbol,
        fillTime,
      },
    };

    const db = getDB(env);

    // Strategy: Try to find the order by various methods
    let order = null;
    let proposal = null;
    let trade = null;

    // Method 1: Find by Tradier order ID
    if (tradierOrderId) {
      const { getOrderByTradierOrderId } = await import('../db/queries_orders');
      order = await getOrderByTradierOrderId(env, tradierOrderId);
    }

    // Method 2: Find by client_order_id
    if (!order && clientOrderId) {
      const { getOrderByClientOrderId } = await import('../db/queries_orders');
      order = await getOrderByClientOrderId(env, clientOrderId);
    }

    // Method 3: Find by proposal ID
    if (!order && proposalId) {
      const { getOrdersByProposalId } = await import('../db/queries_orders');
      const orders = await getOrdersByProposalId(env, proposalId);
      order = orders.find(o => o.side === 'ENTRY') || orders[0] || null;
    }

    // Method 4: Find recent QQQ orders if no ID provided
    if (!order && !tradierOrderId && !clientOrderId && !proposalId) {
      const { getRecentOrders } = await import('../db/queries_orders');
      const recentOrders = await getRecentOrders(env, 50);
      // Find QQQ orders filled around 9:47am
      const targetTime = fillTime ? new Date(fillTime).getTime() : null;
      order = recentOrders.find(o => {
        if (o.symbol !== symbol) return false;
        if (targetTime && o.updated_at) {
          const orderTime = new Date(o.updated_at).getTime();
          // Within 5 minutes of target time
          return Math.abs(orderTime - targetTime) < 5 * 60 * 1000;
        }
        return o.status === 'FILLED';
      }) || recentOrders.find(o => o.symbol === symbol && o.status === 'FILLED') || null;
    }

    if (order) {
      traceResult.order = {
        id: order.id,
        client_order_id: order.client_order_id,
        tradier_order_id: order.tradier_order_id,
        proposal_id: order.proposal_id,
        trade_id: order.trade_id,
        side: order.side,
        status: order.status,
        symbol: order.symbol,
        avg_fill_price: order.avg_fill_price,
        filled_quantity: order.filled_quantity,
        created_at: order.created_at,
        updated_at: order.updated_at,
      };

      // Get proposal
      if (order.proposal_id) {
        proposal = await getProposal(env, order.proposal_id);
        if (proposal) {
          traceResult.proposal = {
            id: proposal.id,
            symbol: proposal.symbol,
            strategy: proposal.strategy,
            expiration: proposal.expiration,
            short_strike: proposal.short_strike,
            long_strike: proposal.long_strike,
            credit_target: proposal.credit_target,
            score: proposal.score,
            status: proposal.status,
            created_at: proposal.created_at,
          };
        }
      }

      // Get trade
      if (order.trade_id) {
        trade = await getTrade(env, order.trade_id);
      } else if (order.proposal_id) {
        // Try to find trade by proposal_id
        const tradesResult = await db.prepare(`
          SELECT * FROM trades WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1
        `).bind(order.proposal_id).first();
        if (tradesResult) {
          trade = tradesResult as any;
        }
      }

      if (trade) {
        traceResult.trade = {
          id: trade.id,
          proposal_id: trade.proposal_id,
          symbol: trade.symbol,
          strategy: trade.strategy,
          expiration: trade.expiration,
          short_strike: trade.short_strike,
          long_strike: trade.long_strike,
          entry_price: trade.entry_price,
          status: trade.status,
          broker_order_id_open: trade.broker_order_id_open,
          opened_at: trade.opened_at,
          created_at: trade.created_at,
        };
      }
    }

    // Verification checks
    const verifications: string[] = [];
    const errors: string[] = [];

    if (order && proposal) {
      // Check 1: Order linked to proposal
      if (order.proposal_id === proposal.id) {
        verifications.push('✓ Order correctly linked to proposal');
      } else {
        errors.push(`✗ Order proposal_id (${order.proposal_id}) doesn't match proposal.id (${proposal.id})`);
      }

      // Check 2: Strategy comes from proposal (orders don't store strategy directly)
      verifications.push(`✓ Order linked to proposal with strategy: ${proposal.strategy}`);
    }

    if (order && trade) {
      // Check 3: Trade linked to order
      if (order.trade_id === trade.id || order.proposal_id === trade.proposal_id) {
        verifications.push('✓ Trade correctly linked to order');
      } else {
        errors.push(`✗ Trade not properly linked to order`);
      }

      // Check 4: Strategy consistency
      if (trade.strategy === proposal?.strategy) {
        verifications.push(`✓ Trade strategy (${trade.strategy}) matches proposal strategy`);
      } else {
        errors.push(`✗ Trade strategy (${trade.strategy}) doesn't match proposal strategy (${proposal?.strategy})`);
      }

      // Check 5: Fill price recorded
      if (order.status === 'FILLED' && order.avg_fill_price) {
        if (trade.entry_price === order.avg_fill_price) {
          verifications.push(`✓ Trade entry_price (${trade.entry_price}) matches order fill price (${order.avg_fill_price})`);
        } else {
          errors.push(`✗ Trade entry_price (${trade.entry_price}) doesn't match order fill price (${order.avg_fill_price})`);
        }
      }

      // Check 6: Trade status
      if (order.status === 'FILLED' && (trade.status === 'OPEN' || trade.status === 'ENTRY_PENDING')) {
        verifications.push(`✓ Trade status (${trade.status}) is appropriate for filled order`);
      } else if (order.status === 'FILLED' && trade.status !== 'OPEN' && trade.status !== 'ENTRY_PENDING') {
        errors.push(`✗ Trade status (${trade.status}) should be OPEN or ENTRY_PENDING for filled order`);
      }
    }

    // Check 7: Fill time tracking
    if (order && order.status === 'FILLED' && order.updated_at) {
      const fillTime = new Date(order.updated_at);
      verifications.push(`✓ Order fill time recorded: ${fillTime.toISOString()} (${fillTime.toLocaleString()})`);
    }

    traceResult.verifications = verifications;
    traceResult.errors = errors;
    traceResult.summary = {
      found: !!(order && proposal && trade),
      orderFound: !!order,
      proposalFound: !!proposal,
      tradeFound: !!trade,
      allLinked: !!(order && proposal && trade && order.proposal_id === proposal.id && (order.trade_id === trade.id || order.proposal_id === trade.proposal_id)),
      strategyConsistent: !!(proposal && trade && proposal.strategy === trade.strategy),
      fillPriceRecorded: !!(order && trade && order.status === 'FILLED' && order.avg_fill_price && trade.entry_price),
    };

    return new Response(
      JSON.stringify(traceResult, null, 2),
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

