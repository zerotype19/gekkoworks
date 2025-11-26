/**
 * Debug Endpoint: View Exit Rule Configuration
 * 
 * GET /debug/exit-rules
 * 
 * Returns all CLOSE_RULE_* settings from the database.
 * Useful for verifying config-driven exit rules are loaded correctly.
 */

import type { Env } from '../env';
import { getDB } from '../db/client';

export async function handleDebugExitRules(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const db = getDB(env);
    
    // Get all exit rule settings
    const result = await db.prepare(`
      SELECT key, value
      FROM settings
      WHERE key LIKE 'CLOSE_RULE_%'
      ORDER BY key
    `).all<{ key: string; value: string }>();
    
    const exitRules: Record<string, string> = {};
    for (const row of result.results || []) {
      exitRules[row.key] = row.value;
    }
    
    // Also show defaults if any are missing
    const expectedRules = [
      'CLOSE_RULE_STOP_LOSS_FRACTION',
      'CLOSE_RULE_PROFIT_TARGET_FRACTION',
      'CLOSE_RULE_TRAILBACK_FRACTION',
      'CLOSE_RULE_TIME_EXIT_DTE',
      'CLOSE_RULE_LOW_VALUE_CLOSE_THRESHOLD',
      'CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD',
      'CLOSE_RULE_UNDERLYING_SPIKE_THRESHOLD',
    ];
    
    const missing = expectedRules.filter(key => !(key in exitRules));
    
    return new Response(
      JSON.stringify({
        exit_rules: exitRules,
        missing_rules: missing,
        defaults_used: missing.length > 0 ? 'Missing rules will use hardcoded defaults' : 'All rules configured',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[debug][exit-rules][error]', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

