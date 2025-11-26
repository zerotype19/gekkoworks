/**
 * Script to check and enable auto mode
 * 
 * Usage: Run this script to verify auto mode is enabled and enable it if needed
 */

import type { Env } from '../env';
import { getSetting, setSetting } from '../db/queries';
import { getTradingMode, isAutoModeEnabled } from '../core/config';

export async function checkAndEnableAutoMode(env: Env): Promise<{
  tradingMode: string;
  autoModeEnabled: boolean;
  wasEnabled: boolean;
  enabled: boolean;
  settings: {
    AUTO_MODE_ENABLED_PAPER: string | null;
    AUTO_MODE_ENABLED_LIVE: string | null;
    TRADING_MODE: string | null;
  };
}> {
  const tradingMode = await getTradingMode(env);
  const autoModeEnabled = await isAutoModeEnabled(env);
  const wasEnabled = autoModeEnabled;
  
  // Get current settings
  const autoModePaper = await getSetting(env, 'AUTO_MODE_ENABLED_PAPER');
  const autoModeLive = await getSetting(env, 'AUTO_MODE_ENABLED_LIVE');
  const tradingModeSetting = await getSetting(env, 'TRADING_MODE');
  
  // Enable auto mode if disabled
  if (!autoModeEnabled) {
    if (tradingMode === 'SANDBOX_PAPER') {
      await setSetting(env, 'AUTO_MODE_ENABLED_PAPER', 'true');
      console.log('[auto-mode] Enabled AUTO_MODE_ENABLED_PAPER');
    } else if (tradingMode === 'LIVE') {
      await setSetting(env, 'AUTO_MODE_ENABLED_LIVE', 'true');
      console.log('[auto-mode] Enabled AUTO_MODE_ENABLED_LIVE');
    }
  }
  
  // Verify it's now enabled
  const nowEnabled = await isAutoModeEnabled(env);
  
  return {
    tradingMode,
    autoModeEnabled: wasEnabled,
    wasEnabled,
    enabled: nowEnabled,
    settings: {
      AUTO_MODE_ENABLED_PAPER: autoModePaper,
      AUTO_MODE_ENABLED_LIVE: autoModeLive,
      TRADING_MODE: tradingModeSetting,
    },
  };
}

