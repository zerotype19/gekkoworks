/**
 * SAS v1 Database Queries
 * 
 * Typed helper functions for all DB operations.
 * All database access must go through these functions.
 */

import type { Env } from '../env';
import type {
  TradeRow,
  ProposalRow,
  SettingRow,
  RiskStateRow,
  BrokerEventRow,
  SystemLogRow,
  TradeStatus,
  ProposalStatus,
} from '../types';
import type { BrokerLogContext } from '../logging/brokerLogger';
import { getDB } from './client';

// ============================================================================
// Trade Queries
// ============================================================================

export async function insertTrade(
  env: Env,
  trade: Omit<TradeRow, 'created_at' | 'updated_at'>
): Promise<TradeRow> {
  const db = getDB(env);
  const now = new Date().toISOString();
  
  const tradeWithTimestamps: TradeRow = {
    ...trade,
    created_at: now,
    updated_at: now,
  };

  try {
    await db.prepare(`
      INSERT INTO trades (
        id, proposal_id, symbol, expiration, short_strike, long_strike, width, quantity,
        entry_price, exit_price, max_profit, max_loss, status, exit_reason,
        broker_order_id_open, broker_order_id_close, opened_at, closed_at,
        created_at, updated_at, realized_pnl, max_seen_profit_fraction, iv_entry
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      tradeWithTimestamps.id,
      tradeWithTimestamps.proposal_id,
      tradeWithTimestamps.symbol,
      tradeWithTimestamps.expiration,
      tradeWithTimestamps.short_strike,
      tradeWithTimestamps.long_strike,
      tradeWithTimestamps.width,
      tradeWithTimestamps.quantity ?? 1, // Default to 1 if not specified
      tradeWithTimestamps.entry_price,
      tradeWithTimestamps.exit_price,
      tradeWithTimestamps.max_profit,
      tradeWithTimestamps.max_loss,
      tradeWithTimestamps.status,
      tradeWithTimestamps.exit_reason,
      tradeWithTimestamps.broker_order_id_open,
      tradeWithTimestamps.broker_order_id_close,
      tradeWithTimestamps.opened_at,
      tradeWithTimestamps.closed_at,
      tradeWithTimestamps.created_at,
      tradeWithTimestamps.updated_at,
      tradeWithTimestamps.realized_pnl,
      tradeWithTimestamps.max_seen_profit_fraction ?? null,
      tradeWithTimestamps.iv_entry ?? null
    ).run();

    console.log('[db] insertTrade success', JSON.stringify({
      id: tradeWithTimestamps.id,
      status: tradeWithTimestamps.status,
    }));

    return tradeWithTimestamps;
  } catch (error) {
    console.error('[db] insertTrade error', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      tradeId: tradeWithTimestamps.id,
      stack: error instanceof Error ? error.stack : undefined,
    }));
    throw error;
  }
}

export async function getTrade(env: Env, tradeId: string): Promise<TradeRow | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM trades WHERE id = ?
  `).bind(tradeId).first<TradeRow>();

  return result || null;
}

export async function updateTrade(
  env: Env,
  tradeId: string,
  updates: Partial<Omit<TradeRow, 'id' | 'created_at'>>
): Promise<TradeRow> {
  const db = getDB(env);
  const now = new Date().toISOString();
  
  // Build dynamic update query
  const fields: string[] = [];
  const values: any[] = [];
  
  Object.entries(updates).forEach(([key, value]) => {
    if (key !== 'id' && key !== 'created_at') {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  });
  
  fields.push('updated_at = ?');
  values.push(now);
  values.push(tradeId);

  await db.prepare(`
    UPDATE trades SET ${fields.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const updated = await getTrade(env, tradeId);
  if (!updated) {
    throw new Error(`Trade ${tradeId} not found after update`);
  }
  return updated;
}

export async function getTradesByStatus(
  env: Env,
  status: TradeStatus
): Promise<TradeRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM trades WHERE status = ? ORDER BY created_at DESC
  `).bind(status).all<TradeRow>();

  return result.results || [];
}

export async function getOpenTrades(env: Env): Promise<TradeRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM trades 
    WHERE status IN ('OPEN', 'CLOSING_PENDING', 'ENTRY_PENDING')
      AND status != 'EXIT_ERROR'
    ORDER BY created_at DESC
  `).all<TradeRow>();

  return result.results || [];
}

export async function getTradesToday(env: Env, date: Date): Promise<TradeRow[]> {
  const db = getDB(env);
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  
  const result = await db.prepare(`
    SELECT * FROM trades 
    WHERE DATE(opened_at) = ? OR DATE(created_at) = ?
    ORDER BY created_at DESC
  `).bind(dateStr, dateStr).all<TradeRow>();

  return result.results || [];
}

export async function getAllTrades(env: Env, limit: number = 100): Promise<TradeRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM trades ORDER BY created_at DESC LIMIT ?
  `).bind(limit).all<TradeRow>();

  return result.results || [];
}

// ============================================================================
// Proposal Queries
// ============================================================================

export async function insertProposal(
  env: Env,
  proposal: Omit<ProposalRow, 'created_at'>
): Promise<ProposalRow> {
  const db = getDB(env);
  const now = new Date().toISOString();
  
  const proposalWithTimestamp: ProposalRow = {
    ...proposal,
    created_at: now,
  };

  await db.prepare(`
    INSERT INTO proposals (
      id, symbol, expiration, short_strike, long_strike, width, quantity,
      strategy, credit_target, score, ivr_score, vertical_skew_score,
      term_structure_score, delta_fitness_score, ev_score,
      created_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    proposalWithTimestamp.id,
    proposalWithTimestamp.symbol,
    proposalWithTimestamp.expiration,
    proposalWithTimestamp.short_strike,
    proposalWithTimestamp.long_strike,
    proposalWithTimestamp.width,
    proposalWithTimestamp.quantity ?? 1,
    proposalWithTimestamp.strategy ?? 'BULL_PUT_CREDIT',
    proposalWithTimestamp.credit_target,
    proposalWithTimestamp.score,
    proposalWithTimestamp.ivr_score,
    proposalWithTimestamp.vertical_skew_score,
    proposalWithTimestamp.term_structure_score,
    proposalWithTimestamp.delta_fitness_score,
    proposalWithTimestamp.ev_score,
    proposalWithTimestamp.created_at,
    proposalWithTimestamp.status
  ).run();

  return proposalWithTimestamp;
}

export async function getProposal(env: Env, proposalId: string): Promise<ProposalRow | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM proposals WHERE id = ?
  `).bind(proposalId).first<ProposalRow>();

  return result || null;
}

export async function getLatestProposal(env: Env): Promise<ProposalRow | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM proposals 
    WHERE status = 'READY'
    ORDER BY created_at DESC
    LIMIT 1
  `).first<ProposalRow>();

  return result || null;
}

export async function getRecentProposals(env: Env, limit: number = 20): Promise<ProposalRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM proposals 
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all<ProposalRow>();

  return result.results || [];
}

export async function updateProposalStatus(
  env: Env,
  proposalId: string,
  status: ProposalStatus
): Promise<ProposalRow> {
  const db = getDB(env);
  
  await db.prepare(`
    UPDATE proposals SET status = ? WHERE id = ?
  `).bind(status, proposalId).run();

  const updated = await getProposal(env, proposalId);
  if (!updated) {
    throw new Error(`Proposal ${proposalId} not found after update`);
  }
  return updated;
}

// ============================================================================
// Settings Queries
// ============================================================================

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT value FROM settings WHERE key = ?
  `).bind(key).first<SettingRow>();

  return result?.value || null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  const db = getDB(env);
  
  await db.prepare(`
    INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
  `).bind(key, value).run();
}

export async function getAllSettings(env: Env): Promise<SettingRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM settings
  `).all<SettingRow>();

  return result.results || [];
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  const db = getDB(env);
  await db.prepare(`
    DELETE FROM settings WHERE key = ?
  `).bind(key).run();
}

/**
 * Clean up price snap entries for a specific trade or all trades
 * Removes PRICE_SNAP_* and PRICE_TIME_* entries from settings table
 */
export async function cleanupPriceSnaps(env: Env, tradeId?: string): Promise<number> {
  const db = getDB(env);
  
  if (tradeId) {
    // Clean up for specific trade
    const patterns = [
      `PRICE_SNAP_${tradeId}_%`,
      `PRICE_TIME_${tradeId}_%`,
    ];
    
    let deleted = 0;
    for (const pattern of patterns) {
      const result = await db.prepare(`
        DELETE FROM settings WHERE key LIKE ?
      `).bind(pattern).run();
      deleted += result.meta.changes || 0;
    }
    return deleted;
  } else {
    // Clean up ALL price snap entries
    const result = await db.prepare(`
      DELETE FROM settings WHERE key LIKE 'PRICE_SNAP_%' OR key LIKE 'PRICE_TIME_%'
    `).run();
    return result.meta.changes || 0;
  }
}

/**
 * Get count of price snap entries in settings table
 */
export async function countPriceSnaps(env: Env): Promise<number> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM settings 
    WHERE key LIKE 'PRICE_SNAP_%' OR key LIKE 'PRICE_TIME_%'
  `).first<{ count: number }>();
  
  return result?.count || 0;
}

// ============================================================================
// Risk State Queries
// ============================================================================

export async function getRiskState(env: Env, key: string): Promise<string | null> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT value FROM risk_state WHERE key = ?
  `).bind(key).first<RiskStateRow>();

  return result?.value || null;
}

export async function setRiskState(env: Env, key: string, value: string): Promise<void> {
  const db = getDB(env);
  
  await db.prepare(`
    INSERT OR REPLACE INTO risk_state (key, value) VALUES (?, ?)
  `).bind(key, value).run();
}

export async function getAllRiskState(env: Env): Promise<RiskStateRow[]> {
  const db = getDB(env);
  const result = await db.prepare(`
    SELECT * FROM risk_state
  `).all<RiskStateRow>();

  return result.results || [];
}

// ============================================================================
// Broker Event Queries
// ============================================================================

export async function insertBrokerEvent(env: Env, ctx: BrokerLogContext): Promise<void> {
  const db = getDB(env);
  const createdAt = new Date().toISOString();
  const okInt = ctx.ok ? 1 : 0;

  await db.prepare(
    `INSERT INTO broker_events (
      id, created_at, operation, symbol, expiration, order_id,
      status_code, ok, duration_ms, mode, error_message, strategy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  .bind(
    null,
    createdAt,
    ctx.operation,
    ctx.symbol ?? null,
    ctx.expiration ?? null,
    ctx.orderId ?? null,
    ctx.statusCode ?? null,
    okInt,
    ctx.durationMs ?? null,
    ctx.mode,
    ctx.errorMessage ?? null,
    ctx.strategy ?? null
  )
  .run();
}

export async function getRecentBrokerEvents(env: Env, limit: number): Promise<BrokerEventRow[]> {
  const db = getDB(env);
  const stmt = db.prepare(
    `SELECT id, created_at, operation, symbol, expiration, order_id,
            status_code, ok, duration_ms, mode, error_message, strategy
     FROM broker_events
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(limit);

  const result = await stmt.all<any>();
  // Convert ok from INTEGER (0/1) to boolean
  return (result.results ?? []).map((row: any): BrokerEventRow => ({
    ...row,
    ok: row.ok === 1,
  }));
}

// ============================================================================
// System Log Queries
// ============================================================================

export async function insertSystemLog(
  env: Env,
  logType: string,
  message: string,
  details?: string
): Promise<void> {
  const db = getDB(env);
  const createdAt = new Date().toISOString();

  await db.prepare(
    `INSERT INTO system_logs (id, created_at, log_type, message, details)
     VALUES (?, ?, ?, ?, ?)`
  )
  .bind(null, createdAt, logType, message, details ?? null)
  .run();
}

export async function getRecentSystemLogs(env: Env, limit: number): Promise<SystemLogRow[]> {
  const db = getDB(env);
  const stmt = db.prepare(
    `SELECT id, created_at, log_type, message, details
     FROM system_logs
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(limit);

  const result = await stmt.all<SystemLogRow>();
  return result.results ?? [];
}

// ============================================================================
// Account Snapshot Queries
// ============================================================================

export async function insertAccountSnapshot(
  env: Env,
  snapshot: {
    account_id: string;
    mode: string;
    date: string;
    captured_at: string;
    cash: number | null;
    buying_power: number | null;
    equity: number | null;
    open_positions: number | null;
    trades_closed_today: number | null;
    realized_pnl_today: number | null;
    realized_pnl_7d: number | null;
    unrealized_pnl_open: number | null;
    source: string;
  }
): Promise<void> {
  const db = getDB(env);

  await db.prepare(
    `INSERT INTO account_snapshots (
      id,
      account_id,
      mode,
      date,
      captured_at,
      cash,
      buying_power,
      equity,
      open_positions,
      trades_closed_today,
      realized_pnl_today,
      realized_pnl_7d,
      unrealized_pnl_open,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      null,
      snapshot.account_id,
      snapshot.mode,
      snapshot.date,
      snapshot.captured_at,
      snapshot.cash,
      snapshot.buying_power,
      snapshot.equity,
      snapshot.open_positions,
      snapshot.trades_closed_today,
      snapshot.realized_pnl_today,
      snapshot.realized_pnl_7d,
      snapshot.unrealized_pnl_open,
      snapshot.source
    )
    .run();
}

export async function getLatestAccountSnapshot(
  env: Env,
  mode: string
): Promise<import('../types').AccountSnapshotRow | null> {
  const db = getDB(env);
  const result = await db
    .prepare(
      `SELECT *
       FROM account_snapshots
       WHERE mode = ?
       ORDER BY captured_at DESC
       LIMIT 1`
    )
    .bind(mode)
    .first<import('../types').AccountSnapshotRow>();

  return result || null;
}

