/**
 * SAS v1 Account Snapshot Sync
 *
 * Periodically syncs account-level balances and PnL from Tradier into D1.
 * Dashboard and monitoring read from this snapshot instead of recomputing live.
 * Also updates all sync freshness timestamps (positions, orders, balances) to keep sync status current.
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { insertAccountSnapshot } from '../db/queries';
import { getETDateString } from '../core/time';
import { getTradingMode } from '../core/config';
import { syncPortfolioFromTradier } from '../engine/portfolioSync';
import { syncOrdersFromTradier } from '../engine/orderSync';
import { syncBalancesFromTradier } from '../engine/balancesSync';

/**
 * Run account snapshot sync
 *
 * Per system-interfaces.md:
 * export async function runAccountSync(env: Env, now: Date): Promise<void>;
 */
export async function runAccountSync(env: Env, now: Date): Promise<void> {
  const accountId = env.TRADIER_ACCOUNT_ID || 'UNKNOWN_ACCOUNT';
  // Use getTradingMode for consistency with rest of system
  // Note: This may differ from TRADIER_ENV if TRADING_MODE is set to DRY_RUN
  const mode = await getTradingMode(env);

  const etDate = getETDateString(now);

  // 1) Sync all data from Tradier (updates freshness timestamps)
  // This ensures all sync freshness is maintained even outside monitor/trade cycles
  // We sync positions, orders, and balances to keep all timestamps fresh
  // 
  // CRITICAL: This sync is essential for exit logic to work correctly.
  // Exit logic now checks Tradier positions directly, but this sync keeps
  // our database in sync and updates freshness timestamps for monitoring.
  // Runs every 1 minute during market hours: */1 14-21 * * MON-FRI
  
  let positionsSyncResult;
  let ordersSyncResult;
  let balancesSyncResult;
  
  try {
    // Sync positions (updates positions sync freshness timestamp)
    positionsSyncResult = await syncPortfolioFromTradier(env);
    if (positionsSyncResult.errors.length > 0) {
      console.error('[accountSync] positions sync had errors', JSON.stringify({
        errors: positionsSyncResult.errors,
      }));
      // Continue anyway - non-fatal for snapshot
    }
    
    // Sync orders (updates orders sync freshness timestamp)
    // Suppress orphaned order logs - they're handled by separate orphanedOrderCleanup cron
    ordersSyncResult = await syncOrdersFromTradier(env, { suppressOrphanedLogs: true });
    if (ordersSyncResult.errors.length > 0) {
      console.error('[accountSync] orders sync had errors', JSON.stringify({
        errors: ordersSyncResult.errors,
      }));
      // Continue anyway - non-fatal for snapshot
    }
    
    // Sync balances (updates balances sync freshness timestamp)
    balancesSyncResult = await syncBalancesFromTradier(env);
    if (!balancesSyncResult.success || !balancesSyncResult.balances) {
      console.error('[accountSync] balances sync failed, continuing with snapshot', JSON.stringify({
        errors: balancesSyncResult.errors,
      }));
      // Continue anyway - we'll use stale balances if needed
    }
    
    console.log('[accountSync] all syncs completed', JSON.stringify({
      positions_synced: positionsSyncResult.synced,
      orders_synced: ordersSyncResult.synced,
      balances_success: balancesSyncResult.success,
    }));
  } catch (error) {
    // Sync errors are logged but don't block snapshot creation
    console.error('[accountSync] sync error (non-fatal)', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  
  const balances = balancesSyncResult?.balances || { cash: 0, buying_power: 0, equity: 0, margin_requirement: 0 };
  
  // 2) Get positions data for snapshot
  // NOTE: This fetches positions again even though syncPortfolioFromTradier already called getPositions.
  // This is intentional for now - syncPortfolioFromTradier doesn't return positions, and we need
  // the raw position data for snapshot calculations. Future optimization: have syncPortfolioFromTradier
  // return positions or cache them to avoid duplicate API calls.
  const client = new TradierClient(env);
  let positions: any[] = [];
  let openPositions = 0;
  let unrealizedOpen = 0;
  
  try {
    positions = await client.getPositions();
    openPositions = positions.length;
    unrealizedOpen = positions.reduce((sum, p) => {
      const gl = p.gain_loss ?? (p.market_value != null && p.cost_basis != null
        ? p.market_value - p.cost_basis
        : 0);
      return sum + gl;
    }, 0);
  } catch (error) {
    // If positions fetch fails, use zeros - snapshot creation should never fail
    console.error('[accountSync] getPositions failed, using zeros', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    openPositions = 0;
    unrealizedOpen = 0;
  }

  // 3) Realized PnL today and closed trades from Tradier gain/loss
  let realizedToday = 0;
  let tradesClosedToday = 0;
  
  try {
    const gainLoss = await client.getGainLoss({
      start: etDate,
      end: etDate,
    });
    realizedToday = gainLoss.reduce(
      (sum, g) => sum + (g.gain_loss || 0),
      0
    );
    tradesClosedToday = gainLoss.length;
  } catch (error) {
    // If gain/loss fetch fails, use zeros - snapshot creation should never fail
    console.error('[accountSync] getGainLoss failed, using zeros', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      date: etDate,
    }));
    realizedToday = 0;
    tradesClosedToday = 0;
  }

  // 4) Persist snapshot
  await insertAccountSnapshot(env, {
    account_id: accountId,
    mode,
    date: etDate,
    captured_at: now.toISOString(),
    cash: balances.cash,
    buying_power: balances.buying_power,
    equity: balances.equity,
    open_positions: openPositions,
    trades_closed_today: tradesClosedToday,
    realized_pnl_today: realizedToday,
    realized_pnl_7d: null, // can be added later using internal or Tradier history
    unrealized_pnl_open: unrealizedOpen,
    source: 'TRADIER',
  });
}

