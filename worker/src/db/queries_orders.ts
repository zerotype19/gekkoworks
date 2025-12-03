/**
 * Order Queries
 * 
 * Functions for managing orders table - the source of truth for order status from Tradier
 */

import type { Env } from '../env';
import type { OrderRow, OrderStatus, OrderSide } from '../types';
import { getDB } from './client';

/**
 * Insert a new order
 */
export async function insertOrder(
  env: Env,
  order: Omit<OrderRow, 'created_at' | 'updated_at'>
): Promise<OrderRow> {
  const db = getDB(env);
  const now = new Date().toISOString();
  
  const orderWithTimestamps: OrderRow = {
    ...order,
    created_at: now,
    updated_at: now,
  };

  try {
    await db.prepare(`
      INSERT INTO orders (
        id, proposal_id, trade_id, client_order_id, tradier_order_id,
        side, status, avg_fill_price, filled_quantity, remaining_quantity,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      orderWithTimestamps.id,
      orderWithTimestamps.proposal_id,
      orderWithTimestamps.trade_id,
      orderWithTimestamps.client_order_id,
      orderWithTimestamps.tradier_order_id,
      orderWithTimestamps.side,
      orderWithTimestamps.status,
      orderWithTimestamps.avg_fill_price,
      orderWithTimestamps.filled_quantity,
      orderWithTimestamps.remaining_quantity,
      orderWithTimestamps.created_at,
      orderWithTimestamps.updated_at,
    ).run();

    return orderWithTimestamps;
  } catch (error) {
    console.error('[db] insertOrder error', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      orderId: orderWithTimestamps.id,
      clientOrderId: orderWithTimestamps.client_order_id,
      stack: error instanceof Error ? error.stack : undefined,
    }));
    throw error;
  }
}

/**
 * Get order by ID
 */
export async function getOrder(env: Env, orderId: string): Promise<OrderRow | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM orders WHERE id = ?
  `).bind(orderId).first<OrderRow>();

  return result || null;
}

/**
 * Get order by client_order_id
 */
export async function getOrderByClientOrderId(
  env: Env,
  clientOrderId: string
): Promise<OrderRow | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM orders WHERE client_order_id = ?
  `).bind(clientOrderId).first<OrderRow>();

  return result || null;
}

/**
 * Get order by tradier_order_id
 */
export async function getOrderByTradierOrderId(
  env: Env,
  tradierOrderId: string
): Promise<OrderRow | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM orders WHERE tradier_order_id = ?
  `).bind(tradierOrderId).first<OrderRow>();

  return result || null;
}

/**
 * Get orders by proposal_id
 */
export async function getOrdersByProposalId(
  env: Env,
  proposalId: string
): Promise<OrderRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM orders WHERE proposal_id = ?
    ORDER BY created_at DESC
  `).bind(proposalId).all<OrderRow>();

  return result.results || [];
}

/**
 * Get orders by trade_id
 */
export async function getOrdersByTradeId(
  env: Env,
  tradeId: string
): Promise<OrderRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM orders WHERE trade_id = ?
    ORDER BY created_at DESC
  `).bind(tradeId).all<OrderRow>();

  return result.results || [];
}

/**
 * Update order
 */
export async function updateOrder(
  env: Env,
  orderId: string,
  updates: Partial<Omit<OrderRow, 'id' | 'created_at'>>
): Promise<OrderRow> {
  const db = getDB(env);
  const now = new Date().toISOString();
  
  // Build dynamic update query
  const fields: string[] = [];
  const values: any[] = [];
  
  Object.entries(updates).forEach(([key, value]) => {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  });
  
  // Always update updated_at
  fields.push('updated_at = ?');
  values.push(now);
  values.push(orderId);

  await db.prepare(`
    UPDATE orders SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const updated = await getOrder(env, orderId);
  if (!updated) {
    throw new Error(`Order ${orderId} not found after update`);
  }
  return updated;
}

/**
 * Get recent orders
 */
export async function getRecentOrders(
  env: Env,
  limit: number = 100
): Promise<OrderRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM orders
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all<OrderRow>();

  return result.results || [];
}

