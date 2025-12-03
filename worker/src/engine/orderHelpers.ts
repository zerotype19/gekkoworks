/**
 * Order Helper Functions
 * 
 * Utilities for creating and managing orders with client_order_id linkage
 */

import type { Env } from '../env';
import type { ProposalRow, TradeRow, OrderSide } from '../types';
import { insertOrder } from '../db/queries_orders';
import { updateProposal } from '../db/queries';

/**
 * Generate a stable client_order_id for a proposal
 */
export function generateClientOrderId(proposalId: string, side: OrderSide): string {
  const timestamp = Date.now();
  return `gekkoworks-${proposalId}-${side.toLowerCase()}-${timestamp}`;
}

/**
 * Create an order record in the database
 */
export async function createOrderRecord(
  env: Env,
  proposal: ProposalRow,
  side: OrderSide,
  clientOrderId: string,
  tradierOrderId: string | null = null
): Promise<string> {
  const orderId = crypto.randomUUID();
  
  await insertOrder(env, {
    id: orderId,
    proposal_id: proposal.id,
    trade_id: null, // Will be populated once trade exists
    client_order_id: clientOrderId,
    tradier_order_id: tradierOrderId,
    side: side,
    status: 'PENDING',
    avg_fill_price: null,
    filled_quantity: 0,
    remaining_quantity: proposal.quantity,
  });

  // Update proposal with client_order_id and kind
  await updateProposal(env, proposal.id, {
    kind: side,
    client_order_id: clientOrderId,
  });

  return orderId;
}

/**
 * Update order record with Tradier response
 */
export async function updateOrderWithTradierResponse(
  env: Env,
  clientOrderId: string,
  tradierOrderId: string,
  status: 'PENDING' | 'PLACED' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED'
): Promise<void> {
  const { getOrderByClientOrderId, updateOrder } = await import('../db/queries_orders');
  const order = await getOrderByClientOrderId(env, clientOrderId);
  if (!order) {
    throw new Error(`Order not found for client_order_id: ${clientOrderId}`);
  }

  await updateOrder(env, order.id, {
    tradier_order_id: tradierOrderId,
    status: status,
  });
}

/**
 * Link order to trade
 */
export async function linkOrderToTrade(
  env: Env,
  clientOrderId: string,
  tradeId: string
): Promise<void> {
  const { getOrderByClientOrderId, updateOrder } = await import('../db/queries_orders');
  const order = await getOrderByClientOrderId(env, clientOrderId);
  if (!order) {
    throw new Error(`Order not found for client_order_id: ${clientOrderId}`);
  }

  await updateOrder(env, order.id, {
    trade_id: tradeId,
  });
}

