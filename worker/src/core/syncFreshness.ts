/**
 * Sync Freshness Tracking
 * 
 * Tracks when we last successfully synced positions, orders, and balances from Tradier.
 * Uses KV store for lightweight, global timestamp storage.
 * 
 * Per spec: Tradier is source of truth, D1 is cache. We must track sync freshness
 * to ensure we never operate on stale data.
 */

import type { Env } from '../env';

const KV_KEY_POSITIONS = 'sync:last_positions';
const KV_KEY_ORDERS = 'sync:last_orders';
const KV_KEY_BALANCES = 'sync:last_balances';

/**
 * Update sync timestamp for positions
 */
export async function updatePositionsSyncTimestamp(env: Env): Promise<void> {
  const timestamp = Date.now().toString();
  await env.SYNC_CACHE.put(KV_KEY_POSITIONS, timestamp);
  console.log('[sync][freshness] updated positions sync timestamp', JSON.stringify({
    timestamp: new Date(parseInt(timestamp)).toISOString(),
  }));
}

/**
 * Update sync timestamp for orders
 */
export async function updateOrdersSyncTimestamp(env: Env): Promise<void> {
  const timestamp = Date.now().toString();
  await env.SYNC_CACHE.put(KV_KEY_ORDERS, timestamp);
  console.log('[sync][freshness] updated orders sync timestamp', JSON.stringify({
    timestamp: new Date(parseInt(timestamp)).toISOString(),
  }));
}

/**
 * Update sync timestamp for balances
 */
export async function updateBalancesSyncTimestamp(env: Env): Promise<void> {
  const timestamp = Date.now().toString();
  await env.SYNC_CACHE.put(KV_KEY_BALANCES, timestamp);
  console.log('[sync][freshness] updated balances sync timestamp', JSON.stringify({
    timestamp: new Date(parseInt(timestamp)).toISOString(),
  }));
}

/**
 * Get last sync timestamp for positions (in ms, or null if never synced)
 */
export async function getLastPositionsSyncTimestamp(env: Env): Promise<number | null> {
  const value = await env.SYNC_CACHE.get(KV_KEY_POSITIONS);
  return value ? parseInt(value) : null;
}

/**
 * Get last sync timestamp for orders (in ms, or null if never synced)
 */
export async function getLastOrdersSyncTimestamp(env: Env): Promise<number | null> {
  const value = await env.SYNC_CACHE.get(KV_KEY_ORDERS);
  return value ? parseInt(value) : null;
}

/**
 * Get last sync timestamp for balances (in ms, or null if never synced)
 */
export async function getLastBalancesSyncTimestamp(env: Env): Promise<number | null> {
  const value = await env.SYNC_CACHE.get(KV_KEY_BALANCES);
  return value ? parseInt(value) : null;
}

/**
 * Get all sync timestamps (for debugging/reporting)
 */
export async function getAllSyncTimestamps(env: Env): Promise<{
  positions: number | null;
  orders: number | null;
  balances: number | null;
}> {
  const [positions, orders, balances] = await Promise.all([
    getLastPositionsSyncTimestamp(env),
    getLastOrdersSyncTimestamp(env),
    getLastBalancesSyncTimestamp(env),
  ]);
  
  return { positions, orders, balances };
}

/**
 * Check if sync is fresh (within maxAgeMs)
 * Returns true if fresh, false if stale or never synced
 */
export async function isSyncFresh(
  env: Env,
  syncType: 'positions' | 'orders' | 'balances',
  maxAgeMs: number
): Promise<boolean> {
  let timestamp: number | null;
  switch (syncType) {
    case 'positions':
      timestamp = await getLastPositionsSyncTimestamp(env);
      break;
    case 'orders':
      timestamp = await getLastOrdersSyncTimestamp(env);
      break;
    case 'balances':
      timestamp = await getLastBalancesSyncTimestamp(env);
      break;
  }
  
  if (timestamp === null) {
    return false; // Never synced
  }
  
  const age = Date.now() - timestamp;
  return age <= maxAgeMs;
}

