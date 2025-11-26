/**
 * Debug Endpoint: Initialize Exit Rules
 * 
 * POST /debug/init-exit-rules
 * 
 * Initializes all exit rule settings with default values if not present.
 * Useful for testing when premarket check hasn't run yet.
 */

import type { Env } from '../env';
import { getSetting, setSetting } from '../db/queries';

export async function handleDebugInitExitRules(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const exitRuleDefaults = {
      'CLOSE_RULE_STOP_LOSS_FRACTION': '-0.50',
      'CLOSE_RULE_PROFIT_TARGET_FRACTION': '0.50',
      'CLOSE_RULE_TRAILBACK_FRACTION': '0.15',
      'CLOSE_RULE_TIME_EXIT_DTE': '2',
      'CLOSE_RULE_LOW_VALUE_CLOSE_THRESHOLD': '0.05',
      'CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD': '0.30',
      'CLOSE_RULE_UNDERLYING_SPIKE_THRESHOLD': '0.005',
    };
    
    const initialized: string[] = [];
    const skipped: string[] = [];
    
    for (const [key, defaultValue] of Object.entries(exitRuleDefaults)) {
      const existing = await getSetting(env, key);
      if (!existing) {
        await setSetting(env, key, defaultValue);
        initialized.push(key);
      } else {
        skipped.push(key);
      }
    }
    
    return new Response(
      JSON.stringify({
        success: true,
        initialized,
        skipped,
        message: initialized.length > 0 
          ? `Initialized ${initialized.length} exit rule settings`
          : 'All exit rule settings already exist',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[debug][init-exit-rules][error]', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

