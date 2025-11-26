/**
 * Debug endpoint to check and enable auto mode
 * 
 * GET /debug/enable-auto-mode - Check current status
 * POST /debug/enable-auto-mode - Enable auto mode if disabled
 */

import type { Env } from '../env';
import { getSetting, setSetting } from '../db/queries';
import { getTradingMode, isAutoModeEnabled } from '../core/config';

export async function handleDebugEnableAutoMode(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const tradingMode = await getTradingMode(env);
    const autoModeEnabled = await isAutoModeEnabled(env);
    
    // Get current settings
    const autoModePaper = await getSetting(env, 'AUTO_MODE_ENABLED_PAPER');
    const autoModeLive = await getSetting(env, 'AUTO_MODE_ENABLED_LIVE');
    const tradingModeSetting = await getSetting(env, 'TRADING_MODE');
    
    const wasEnabled = autoModeEnabled;
    let enabled = autoModeEnabled;
    let action = 'none';
    
    // If POST request, enable auto mode if disabled
    if (request.method === 'POST') {
      if (!autoModeEnabled) {
        if (tradingMode === 'SANDBOX_PAPER') {
          await setSetting(env, 'AUTO_MODE_ENABLED_PAPER', 'true');
          action = 'enabled_paper';
          enabled = true;
        } else if (tradingMode === 'LIVE') {
          await setSetting(env, 'AUTO_MODE_ENABLED_LIVE', 'true');
          action = 'enabled_live';
          enabled = true;
        }
      } else {
        action = 'already_enabled';
      }
    }
    
    // Verify current status
    const currentStatus = await isAutoModeEnabled(env);
    
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        tradingMode,
        autoMode: {
          enabled: currentStatus,
          wasEnabled,
          action,
        },
        settings: {
          AUTO_MODE_ENABLED_PAPER: autoModePaper,
          AUTO_MODE_ENABLED_LIVE: autoModeLive,
          TRADING_MODE: tradingModeSetting,
        },
        message: currentStatus 
          ? 'Auto mode is ENABLED - orders will be placed automatically'
          : 'Auto mode is DISABLED - orders require manual approval. Use POST to enable.',
      }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

