/**
 * Debug Endpoint: System Mode Management
 * 
 * GET /debug/system-mode - View current system mode and history
 * POST /debug/system-mode - Change system mode (PAPER/SANDBOX only)
 */

import type { Env } from '../env';
import { getRiskSnapshot } from '../core/risk';
import { getSystemModeHistory, setSystemMode } from '../core/systemMode';
import { getTradingMode } from '../core/config';
import { getRiskState } from '../db/queries';

export async function handleDebugSystemMode(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    if (request.method === 'GET') {
      // View current system mode
      const now = new Date();
      const snapshot = await getRiskSnapshot(env, now);
      const tradingMode = await getTradingMode(env);
      const lastHardStopAt = await getRiskState(env, 'LAST_HARD_STOP_AT');
      const lastHardStopReason = await getRiskState(env, 'LAST_HARD_STOP_REASON');
      const lastModeChange = await getRiskState(env, 'LAST_SYSTEM_MODE_CHANGE');
      const history = await getSystemModeHistory(env, 10);
      
      return new Response(
        JSON.stringify({
          system_mode: snapshot.system_mode,
          risk_state: snapshot.risk_state,
          emergency_exit_count_today: snapshot.emergency_exit_count_today,
          trading_mode: tradingMode,
          last_hard_stop_at: lastHardStopAt,
          last_hard_stop_reason: lastHardStopReason,
          last_mode_change: lastModeChange,
          history: history.slice(0, 5), // Last 5 changes
          timestamp: now.toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else if (request.method === 'POST') {
      // Change system mode (PAPER/SANDBOX only)
      const tradingMode = await getTradingMode(env);
      
      if (tradingMode === 'LIVE') {
        return new Response(
          JSON.stringify({ error: 'System mode changes disabled in LIVE mode' }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      
      const body = await request.json() as { mode?: string; reason?: string };
      const newMode = body.mode as 'NORMAL' | 'HARD_STOP';
      const reason = body.reason || 'MANUAL_OVERRIDE';
      
      if (newMode !== 'NORMAL' && newMode !== 'HARD_STOP') {
        return new Response(
          JSON.stringify({ error: 'Invalid mode. Must be NORMAL or HARD_STOP' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      
      await setSystemMode(env, newMode, reason, {
        source: 'debug_endpoint',
        trading_mode: tradingMode,
      });
      
      return new Response(
        JSON.stringify({
          success: true,
          system_mode: newMode,
          reason,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  } catch (error) {
    console.error('[debug][system-mode][error]', JSON.stringify({
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

