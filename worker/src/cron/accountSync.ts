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
import { syncTradierSnapshot } from '../tradier/syncTradierSnapshot';

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

  // 1) Master sync from Tradier (updates all freshness timestamps)
  // This ensures all sync freshness is maintained even outside monitor/trade cycles
  // The master sync fetches positions, orders, and balances in a single coherent snapshot
  // 
  // CRITICAL: This sync is essential for exit logic to work correctly.
  // Exit logic uses the portfolio_positions mirror as its source of truth for quantities;
  // this sync keeps that table and the freshness timestamps up to date.
  // Runs every 1 minute during market hours: */1 14-21 * * MON-FRI
  
  let syncResult;
  let balances = { cash: 0, buying_power: 0, equity: 0, margin_requirement: 0 };
  
  try {
    syncResult = await syncTradierSnapshot(env);
    
    if (!syncResult.success) {
      console.error('[accountSync] master sync failed', JSON.stringify({
        errors: syncResult.errors,
        warnings: syncResult.warnings,
        note: 'Continuing with snapshot using stale data',
      }));
    } else {
      balances = syncResult.snapshot?.balances || balances;
      console.log('[accountSync] master sync completed', JSON.stringify({
        snapshotId: syncResult.snapshot?.snapshotId,
        positions: syncResult.snapshot?.counts.positions,
        orders: syncResult.snapshot?.counts.orders,
        balances_success: syncResult.snapshot?.balances !== null,
        warnings: syncResult.warnings.length,
      }));
    }
  } catch (error) {
    // Sync errors are logged but don't block snapshot creation
    console.error('[accountSync] sync error (non-fatal)', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  
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
  // CRITICAL: Wrap in try-catch to handle D1 rate limit errors gracefully
  // If we've already made too many D1 operations (e.g., from orderSync), skip snapshot
  try {
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
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // If it's a D1 rate limit error, log and continue (non-fatal)
    // The sync operations already completed, so missing one snapshot is acceptable
    if (errorMsg.includes('Too many API requests')) {
      console.warn('[accountSync] skipped snapshot due to D1 rate limit', JSON.stringify({
        error: errorMsg,
        note: 'Sync operations completed - snapshot skipped to avoid rate limit',
      }));
    } else {
      // Other errors should be logged as errors
      console.error('[accountSync] failed to insert snapshot', JSON.stringify({
        error: errorMsg,
      }));
    }
  }
}

