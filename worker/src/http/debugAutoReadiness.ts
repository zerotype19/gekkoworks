/**
 * Auto Mode Readiness Check Endpoint
 * 
 * Returns comprehensive readiness status for auto mode.
 */

import type { Env } from '../env';
import { getTradingMode, getMinScore } from '../core/config';
import { getSetting, getOpenTrades, getTradesToday } from '../db/queries';
import { getRiskSnapshot } from '../core/risk';
import { 
  getLastPositionsSyncTimestamp, 
  getLastOrdersSyncTimestamp, 
  getLastBalancesSyncTimestamp 
} from '../core/syncFreshness';

export async function handleDebugAutoReadiness(
  request: Request,
  env: Env
): Promise<Response> {
  const now = new Date();
  
  try {
    const envMode = await getTradingMode(env);
    const minScore = await getMinScore(env);
    
    // Determine if auto mode is enabled for current mode
    let autoModeEnabled = false;
    if (envMode === 'SANDBOX_PAPER') {
      autoModeEnabled = (await getSetting(env, 'AUTO_MODE_ENABLED_PAPER')) === 'true';
    } else if (envMode === 'LIVE') {
      autoModeEnabled = (await getSetting(env, 'AUTO_MODE_ENABLED_LIVE')) === 'true';
    }
    
    // Get risk snapshot
    const riskSnapshot = await getRiskSnapshot(env, now);
    
    // Get open trades count
    const openTrades = await getOpenTrades(env);
    const openSpreadsCount = openTrades.length;
    
    // Get trades opened today (count trades that were opened today, excluding cancelled/failed)
    const tradesToday = await getTradesToday(env, now);
    const todayDateString = now.toDateString();
    // Count only trades that were actually opened today (have opened_at set to today)
    // Exclude cancelled and failed trades
    const openedToday = tradesToday.filter(t => 
      t.opened_at && 
      new Date(t.opened_at).toDateString() === todayDateString &&
      t.status !== 'CANCELLED' && 
      t.status !== 'CLOSE_FAILED' &&
      t.status !== 'ENTRY_PENDING' // Don't count pending entries
    ).length;
    
    // Get exposure caps
    const maxOpenSpreadsGlobal = parseInt(
      (await getSetting(env, 'MAX_OPEN_SPREADS_GLOBAL')) || '10'
    );
    const maxOpenSpreadsPerSymbol = parseInt(
      (await getSetting(env, 'MAX_OPEN_SPREADS_PER_SYMBOL')) || '5'
    );
    const maxNewTradesPerDay = parseInt(
      (await getSetting(env, 'MAX_NEW_TRADES_PER_DAY')) || '5'
    );
    
    // Check sync freshness
    const lastPositionsSyncMs = await getLastPositionsSyncTimestamp(env);
    const lastOrdersSyncMs = await getLastOrdersSyncTimestamp(env);
    const lastBalancesSyncMs = await getLastBalancesSyncTimestamp(env);
    
    const lastPositionsSync = lastPositionsSyncMs ? new Date(lastPositionsSyncMs) : null;
    const lastOrdersSync = lastOrdersSyncMs ? new Date(lastOrdersSyncMs) : null;
    const lastBalancesSync = lastBalancesSyncMs ? new Date(lastBalancesSyncMs) : null;
    
    const syncFresh = {
      positions: lastPositionsSyncMs ? (now.getTime() - lastPositionsSyncMs) < 2 * 60 * 1000 : false,
      orders: lastOrdersSyncMs ? (now.getTime() - lastOrdersSyncMs) < 2 * 60 * 1000 : false,
      balances: lastBalancesSyncMs ? (now.getTime() - lastBalancesSyncMs) < 2 * 60 * 1000 : false,
    };
    
    // Check for risk flags
    const riskFlags = {
      hardStop: riskSnapshot.system_mode === 'HARD_STOP',
      emergencyExits: riskSnapshot.emergency_exit_count_today > 0,
      riskState: riskSnapshot.risk_state !== 'NORMAL',
      syncFailures: !syncFresh.positions || !syncFresh.orders || !syncFresh.balances,
    };
    
    const hasRiskFlags = Object.values(riskFlags).some(v => v === true);
    
    // Overall readiness
    const ready = autoModeEnabled && !hasRiskFlags && envMode === 'SANDBOX_PAPER';
    
    return new Response(
      JSON.stringify({
        timestamp: now.toISOString(),
        ready,
        envMode,
        autoMode: {
          enabled: autoModeEnabled,
          minScore,
        },
        exposure: {
          openSpreads: openSpreadsCount,
          openedToday,
          limits: {
            maxOpenSpreadsGlobal,
            maxOpenSpreadsPerSymbol,
            maxNewTradesPerDay,
          },
          withinLimits: {
            global: openSpreadsCount < maxOpenSpreadsGlobal,
            perSymbol: true, // Would need symbol breakdown to check
            daily: openedToday < maxNewTradesPerDay,
          },
        },
        risk: {
          systemMode: riskSnapshot.system_mode,
          riskState: riskSnapshot.risk_state,
          emergencyExitsToday: riskSnapshot.emergency_exit_count_today,
          flags: riskFlags,
        },
        sync: {
          positions: {
            fresh: syncFresh.positions,
            lastSync: lastPositionsSync?.toISOString() || null,
          },
          orders: {
            fresh: syncFresh.orders,
            lastSync: lastOrdersSync?.toISOString() || null,
          },
          balances: {
            fresh: syncFresh.balances,
            lastSync: lastBalancesSync?.toISOString() || null,
          },
        },
      }, null, 2),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        timestamp: now.toISOString(),
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

