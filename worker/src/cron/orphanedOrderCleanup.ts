/**
 * Orphaned Order Cleanup Cron
 * 
 * Runs periodically to identify and clean up orphaned orders (orders in Tradier
 * but not in our database). This runs less frequently than the main trade cycle
 * to avoid cluttering logs with orphaned order messages.
 */

import type { Env } from '../env';
import { syncOrdersFromTradier } from '../engine/orderSync';
import { insertSystemLog, setSetting } from '../db/queries';
import { getTradingMode } from '../core/config';

/**
 * Run orphaned order cleanup
 * 
 * NOTE: This cron delegates all cleanup logic to syncOrdersFromTradier in orderSync.ts.
 * The actual orphan detection and cancellation happens there. This cron provides:
 * - A dedicated cleanup cadence (e.g., off-hours) separate from monitorCycle
 * - Clean, labeled log stream for observability
 * 
 * Note that monitorCycle also calls syncOrdersFromTradier (without suppressOrphanedLogs),
 * so orphan cleanup happens in multiple places. This cron is primarily for redundancy
 * and dedicated cleanup runs outside the normal monitor cadence.
 */
export async function runOrphanedOrderCleanup(env: Env, now: Date): Promise<void> {
  const mode = await getTradingMode(env);
  
  try {
    console.log('[orphanedOrderCleanup] starting cleanup', JSON.stringify({
      timestamp: now.toISOString(),
      mode,
    }));

    // Sync orders - this will log orphaned orders
    const result = await syncOrdersFromTradier(env);

    console.log('[orphanedOrderCleanup] cleanup complete', JSON.stringify({
      mode,
      synced: result.synced,
      updated: result.updated,
      created: result.created,
      errors: result.errors.length,
      timestamp: now.toISOString(),
    }));

    await insertSystemLog(
      env,
      'orphanedOrderCleanup',
      `Cleanup complete: ${result.synced} synced, ${result.updated} updated, ${result.errors.length} errors`,
      JSON.stringify({
        mode,
        synced: result.synced,
        updated: result.updated,
        created: result.created,
        errors: result.errors,
      })
    ).catch(() => {}); // Non-blocking
    
    // Update last run timestamp for consistency with other crons
    await setSetting(env, 'LAST_ORPHANED_ORDER_CLEANUP_RUN', now.toISOString()).catch(() => {});

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[orphanedOrderCleanup] cleanup failed', JSON.stringify({
      mode,
      error: errorMsg,
      timestamp: now.toISOString(),
    }));
    
    await insertSystemLog(
      env,
      'orphanedOrderCleanup',
      `Cleanup failed: ${errorMsg}`,
      JSON.stringify({
        mode,
        error: errorMsg,
      })
    ).catch(() => {}); // Non-blocking
    
    // Update last run timestamp even on failure (for heartbeat tracking)
    await setSetting(env, 'LAST_ORPHANED_ORDER_CLEANUP_RUN', now.toISOString()).catch(() => {});
  }
}

