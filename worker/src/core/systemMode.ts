/**
 * System Mode Management
 * 
 * Centralized logging and management for system mode changes.
 * Ensures HARD_STOP is only triggered for legitimate reasons.
 */

import type { Env } from '../env';
import { getRiskState, setRiskState } from '../db/queries';
import { insertSystemLog } from '../db/queries';
import type { SystemMode } from '../types';

export interface SystemModeChange {
  from: SystemMode;
  to: SystemMode;
  reason: string;
  details?: Record<string, any>;
  timestamp: string;
}

/**
 * Set system mode with logging
 */
export async function setSystemMode(
  env: Env,
  newMode: SystemMode,
  reason: string,
  details?: Record<string, any>
): Promise<void> {
  const oldMode = ((await getRiskState(env, 'SYSTEM_MODE')) as SystemMode) || 'NORMAL';
  
  // Only log if mode actually changes
  if (oldMode !== newMode) {
    const change: SystemModeChange = {
      from: oldMode,
      to: newMode,
      reason,
      details,
      timestamp: new Date().toISOString(),
    };
    
    // Log to console
    console.log('[system][mode-change]', JSON.stringify(change));
    
    // Log to system_logs table
    await insertSystemLog(
      env,
      'system_mode_change',
      `System mode changed from ${oldMode} to ${newMode}`,
      JSON.stringify(change)
    ).catch(() => {}); // Non-blocking
    
    // Update risk state
    await setRiskState(env, 'SYSTEM_MODE', newMode);
    
    // Store last change timestamp
    await setRiskState(env, 'LAST_SYSTEM_MODE_CHANGE', change.timestamp);
    
    // If entering HARD_STOP, store reason
    if (newMode === 'HARD_STOP') {
      await setRiskState(env, 'LAST_HARD_STOP_AT', change.timestamp);
      await setRiskState(env, 'LAST_HARD_STOP_REASON', reason);
    }
  }
}

/**
 * Get system mode change history (last N changes)
 */
export async function getSystemModeHistory(
  env: Env,
  limit: number = 10
): Promise<SystemModeChange[]> {
  // For now, we'll get from system_logs
  // In the future, could add a dedicated table
  const db = (await import('../db/client')).getDB(env);
  const result = await db.prepare(`
    SELECT details
    FROM system_logs
    WHERE log_type = 'system_mode_change'
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all<{ details: string }>();
  
  return (result.results || [])
    .map(row => {
      try {
        return JSON.parse(row.details) as SystemModeChange;
      } catch {
        return null;
      }
    })
    .filter((change): change is SystemModeChange => change !== null);
}

/**
 * Check if an error is a benign after-hours rejection
 */
export function isBenignRejection(error: Error | string): boolean {
  const errorStr = typeof error === 'string' ? error : error.message;
  const lower = errorStr.toLowerCase();
  
  // Common Tradier after-hours rejection patterns
  const benignPatterns = [
    'market closed',
    'trading hours',
    'outside trading hours',
    'session not open',
    'market is closed',
    'after hours',
    'pre-market',
    'post-market',
    'not a trading day',
    'weekend',
    'holiday',
  ];
  
  return benignPatterns.some(pattern => lower.includes(pattern));
}

