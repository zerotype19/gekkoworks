/**
 * DB Health Check Endpoint
 * 
 * Per Phase 2 checklist: provides quick way to confirm no D1/SQL calls are broken.
 */

import type { Env } from '../env';
import { getDB } from '../db/client';
import { getOpenTrades, getAllTrades } from '../db/queries';
import { TradierClient } from '../broker/tradierClient';

export async function handleDebugHealthDb(
  request: Request,
  env: Env
): Promise<Response> {
  const results: Record<string, any> = {
    timestamp: new Date().toISOString(),
    checks: {},
  };

  // 1. Check latest quote for SPY
  try {
    const broker = new TradierClient(env);
    const quote = await broker.getUnderlyingQuote('SPY');
    results.checks.quote_spy = {
      ok: true,
      symbol: quote.symbol,
      last: quote.last,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[db][error][health] quote_spy', error instanceof Error ? error.message : String(error));
    results.checks.quote_spy = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 2. Count trades by status
  try {
    const db = getDB(env);
    const statusCounts = await db.prepare(`
      SELECT status, COUNT(*) as count
      FROM trades
      GROUP BY status
    `).all<{ status: string; count: number }>();

    const counts: Record<string, number> = {};
    for (const row of statusCounts.results || []) {
      counts[row.status] = row.count;
    }

    const latestTrade = await db.prepare(`
      SELECT created_at, updated_at
      FROM trades
      ORDER BY created_at DESC
      LIMIT 1
    `).first<{ created_at: string; updated_at: string }>();

    results.checks.trades_by_status = {
      ok: true,
      counts,
      latest_created_at: latestTrade?.created_at || null,
      latest_updated_at: latestTrade?.updated_at || null,
    };
  } catch (error) {
    console.error('[db][error][health] trades_by_status', error instanceof Error ? error.message : String(error));
    results.checks.trades_by_status = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 3. Count open trades
  try {
    const openTrades = await getOpenTrades(env);
    results.checks.open_trades = {
      ok: true,
      count: openTrades.length,
      sample_ids: openTrades.slice(0, 5).map(t => t.id),
    };
  } catch (error) {
    console.error('[db][error][health] open_trades', error instanceof Error ? error.message : String(error));
    results.checks.open_trades = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 4. Check settings table
  try {
    const db = getDB(env);
    const settingsCount = await db.prepare(`
      SELECT COUNT(*) as count FROM settings
    `).first<{ count: number }>();

    const closeRuleSettings = await db.prepare(`
      SELECT key, value
      FROM settings
      WHERE key LIKE 'CLOSE_RULE_%'
      ORDER BY key
    `).all<{ key: string; value: string }>();

    results.checks.settings = {
      ok: true,
      total_count: settingsCount?.count || 0,
      close_rule_settings: (closeRuleSettings.results || []).map(s => ({
        key: s.key,
        value: s.value,
      })),
    };
  } catch (error) {
    console.error('[db][error][health] settings', error instanceof Error ? error.message : String(error));
    results.checks.settings = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const allOk = Object.values(results.checks).every((check: any) => check.ok === true);

  return new Response(
    JSON.stringify(results, null, 2),
    {
      status: allOk ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

