/**
 * SAS v1 Trade Cycle
 * 
 * Runs during market hours to generate proposals and attempt entries.
 * Per architecture.md.
 */

import type { Env } from '../env';
import { canOpenNewTrade } from '../core/risk';
import { getSetting, setSetting } from '../db/queries';
import { isMarketHours } from '../core/time';
import { getTradingMode } from '../core/config';
import { generateProposal } from '../engine/proposals';
import { attemptEntryForLatestProposal } from '../engine/entry';
import { insertSystemLog } from '../db/queries';
import { syncPortfolioFromTradier } from '../engine/portfolioSync';
import { syncOrdersFromTradier } from '../engine/orderSync';
import { syncBalancesFromTradier } from '../engine/balancesSync';

/**
 * Run trade cycle
 * 
 * Per system-interfaces.md:
 * export async function runTradeCycle(env: Env, now: Date): Promise<void>;
 */
export async function runTradeCycle(env: Env, now: Date): Promise<void> {
  const cycleStartTime = Date.now();
  
  // 0. Sync from Tradier (source of truth) - per Tradier-first spec
  // NOTE: Syncs run even outside market hours to keep data fresh
  // This ensures we always work from current broker state before making decisions
  // (Dedicated sync crons may also run, but this ensures tradeCycle has fresh data)
  try {
    const positionsSyncResult = await syncPortfolioFromTradier(env);
    // Portfolio sync errors are typically non-fatal (e.g., "options not found in chain")
    // Only abort if sync completely failed (caught in outer catch)
    if (positionsSyncResult.errors.length > 0) {
      console.warn('[tradeCycle][sync][warnings] positions sync had non-fatal issues', JSON.stringify({
        errors: positionsSyncResult.errors,
        synced: positionsSyncResult.synced,
        note: 'Continuing with sync - these are typically data oddities, not fatal failures',
      }));
    }
    
    // Sync orders but suppress orphaned order logs (they're handled by separate cron)
    const ordersSyncResult = await syncOrdersFromTradier(env, { suppressOrphanedLogs: true });
    // Order sync errors are typically non-fatal (e.g., individual order sync failures)
    // Only abort if sync completely failed (caught in outer catch)
    if (ordersSyncResult.errors.length > 0) {
      console.warn('[tradeCycle][sync][warnings] orders sync had non-fatal issues', JSON.stringify({
        errors: ordersSyncResult.errors,
        synced: ordersSyncResult.synced,
        note: 'Continuing with sync - these are typically individual order issues, not fatal failures',
      }));
    }
    
    const balancesSyncResult = await syncBalancesFromTradier(env);
    // Balances sync is critical - must succeed to proceed with trading
    if (!balancesSyncResult.success) {
      console.error('[tradeCycle][sync][fatal] balances sync failed', JSON.stringify({
        errors: balancesSyncResult.errors,
      }));
      throw new Error(`Balances sync failed: ${balancesSyncResult.errors.join(', ')}`);
    }
    
    console.log('[tradeCycle] all syncs completed', JSON.stringify({
      positions_synced: positionsSyncResult.synced,
      positions_warnings: positionsSyncResult.errors.length,
      orders_synced: ordersSyncResult.synced,
      orders_warnings: ordersSyncResult.errors.length,
      balances_success: balancesSyncResult.success,
    }));
  } catch (error) {
    // Fatal sync failure (e.g., Tradier API down, auth issues, balances sync failed)
    // Abort cycle - cannot proceed without fresh Tradier data
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[tradeCycle][sync][fatal] unable to refresh from Tradier; skipping trading cycle', JSON.stringify({
      error: errorMsg,
    }));
    // Do NOT set LAST_PROPOSAL_RUN - no proposal was generated
    // Instead, track the error separately
    await setSetting(env, 'LAST_TRADE_CYCLE_ERROR', now.toISOString()).catch(() => {});
    await insertSystemLog(env, 'tradeCycle', `Sync failed: ${errorMsg}`).catch(() => {});
    return; // Abort - cannot proceed without fresh Tradier data
  }
  
  // 1. Check market hours
  if (!isMarketHours(now)) {
    const msg = '[tradeCycle] market closed, skipping';
    console.log(msg);
    await insertSystemLog(env, 'tradeCycle', msg).catch(() => {}); // Non-blocking
    // Still update heartbeat even if market is closed
    await setSetting(env, 'LAST_TRADE_CYCLE_HEARTBEAT', now.toISOString()).catch(() => {});
    return; // Outside market hours
  }
  
  // 2. Check risk gates
  if (!(await canOpenNewTrade(env, now))) {
    const msg = '[tradeCycle] canOpenNewTrade=false, skipping';
    console.log(msg);
    await insertSystemLog(env, 'tradeCycle', msg).catch(() => {}); // Non-blocking
    // Still update heartbeat even if risk gates block
    await setSetting(env, 'LAST_TRADE_CYCLE_HEARTBEAT', now.toISOString()).catch(() => {});
    return; // Risk gates prevent trading
  }
  
  // 3. Check current open positions against MAX_OPEN_POSITIONS (configurable)
  // NOTE: All trades are managed by Gekkoworks - portfolioSync imports all open spreads
  // External spreads opened manually in Tradier will be imported and count toward this limit
  // NOTE: MAX_OPEN_POSITIONS is per spread (trade), not per contract
  // If you have multiple contracts per spread, it still counts as 1 trade
  // If you need contract-based capacity, you would need to sum trade.quantity instead
  const { getOpenTrades } = await import('../db/queries');
  const openTrades = await getOpenTrades(env);
  const maxOpenSetting = await getSetting(env, 'MAX_OPEN_POSITIONS');
  let maxOpenPositions = parseInt(maxOpenSetting || '10', 10);
  // Guard against invalid config - prevent NaN from silently disabling the limit
  if (!Number.isFinite(maxOpenPositions) || maxOpenPositions <= 0) {
    console.warn('[tradeCycle] invalid MAX_OPEN_POSITIONS; defaulting to 10', JSON.stringify({
      value: maxOpenSetting,
      parsed: maxOpenPositions,
    }));
    maxOpenPositions = 10;
  }
  
  if (openTrades.length >= maxOpenPositions) {
    const msg = `[tradeCycle] already have ${openTrades.length} open position(s), max=${maxOpenPositions}, skipping`;
    console.log(msg);
    await insertSystemLog(env, 'tradeCycle', msg).catch(() => {}); // Non-blocking
    // Still update heartbeat even if at max positions
    await setSetting(env, 'LAST_TRADE_CYCLE_HEARTBEAT', now.toISOString()).catch(() => {});
    return; // Already at max managed open positions
  }
  
  // 4. Generate proposal
  const proposalResult = await generateProposal(env, now);
  
  if (!proposalResult.proposal) {
    // Detailed logging - the proposal engine already logs [proposals] summary
    // This log provides context at the tradeCycle level
    const msg = '[tradeCycle] no viable candidate - see [proposals] summary log for details (score below threshold, filters failed, or no candidates built)';
    console.log(msg);
    await insertSystemLog(env, 'tradeCycle', msg).catch(() => {}); // Non-blocking
    // Update heartbeat even when no viable candidate (cron is alive, just no trade opportunity)
    await setSetting(env, 'LAST_TRADE_CYCLE_HEARTBEAT', now.toISOString()).catch(() => {});
    return; // No valid proposal generated
  }
  
  const msg = `[tradeCycle] proposal generated: ${proposalResult.proposal.id}, score: ${proposalResult.proposal.score}`;
  console.log(msg);
  await insertSystemLog(env, 'tradeCycle', msg).catch(() => {}); // Non-blocking
  
  // 5. Attempt entry
  const entryResult = await attemptEntryForLatestProposal(env, now);
  
  if (entryResult.trade) {
    const successMsg = `[tradeCycle] entry successful: trade ${entryResult.trade.id} created`;
    console.log(successMsg);
    await insertSystemLog(env, 'tradeCycle', successMsg).catch(() => {}); // Non-blocking
  } else {
    const rejectReason = entryResult.reason || 'unknown reason (no reason provided in EntryAttemptResult)';
    const rejectMsg = `[tradeCycle] entry rejected: ${rejectReason}`;
    console.log(rejectMsg);
    console.log('[tradeCycle] entry rejection details', JSON.stringify({
      proposal_id: proposalResult.proposal?.id,
      proposal_score: proposalResult.proposal?.score,
      proposal_strategy: proposalResult.proposal?.strategy,
      proposal_symbol: proposalResult.proposal?.symbol,
      entry_result: {
        trade: entryResult.trade,
        reason: entryResult.reason,
      },
    }));
    await insertSystemLog(env, 'tradeCycle', rejectMsg).catch(() => {}); // Non-blocking
  }
  
  // 6. Track last proposal+entry attempt
  // This only updates when we had a concrete proposal and attempted an entry order.
  // Used for cadence/throttling - distinguishes "we tried to place something" from "no viable candidate"
  await setSetting(env, 'LAST_PROPOSAL_RUN', now.toISOString()).catch(() => {});
  
  // Also update heartbeat to confirm cron ran (separate from proposal attempt)
  // This provides "cron is alive" signal even when no proposal was attempted
  await setSetting(env, 'LAST_TRADE_CYCLE_HEARTBEAT', now.toISOString()).catch(() => {});
  
  // Clear error marker on successful run (system recovered from any previous sync failures)
  await setSetting(env, 'LAST_TRADE_CYCLE_ERROR', '').catch(() => {});
  
  // Log cycle completion with duration for observability
  const cycleDuration = Date.now() - cycleStartTime;
  const mode = await getTradingMode(env);
  console.log('[tradeCycle] complete', JSON.stringify({
    duration_ms: cycleDuration,
    trading_mode: mode,
    open_trades_before: openTrades.length,
    max_open_positions: maxOpenPositions,
    proposal_id: proposalResult.proposal?.id ?? null,
    entry_success: !!entryResult.trade,
    entry_reason: entryResult.reason ?? null,
  }));
}

