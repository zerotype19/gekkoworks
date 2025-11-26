/**
 * Balances Sync Engine
 * 
 * Syncs account balances from Tradier.
 * Tradier is source of truth for cash, buying power, equity, margin.
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getTradingMode } from '../core/config';
import { updateBalancesSyncTimestamp } from '../core/syncFreshness';

export interface BalancesSyncResult {
  success: boolean;
  balances: {
    cash: number;
    buying_power: number;
    equity: number;
    margin_requirement: number;
  } | null;
  errors: string[];
}

/**
 * Sync balances from Tradier
 * 
 * Fetches current account balances and stores them.
 * Updates sync freshness timestamp on success.
 */
export async function syncBalancesFromTradier(env: Env): Promise<BalancesSyncResult> {
  const broker = new TradierClient(env);
  const mode = await getTradingMode(env);
  
  const result: BalancesSyncResult = {
    success: false,
    balances: null,
    errors: [],
  };

  try {
    const balances = await broker.getBalances();
    
    result.success = true;
    result.balances = balances;
    
    // Update sync freshness timestamp on successful sync
    await updateBalancesSyncTimestamp(env);
    
    console.log('[balancesSync] sync complete', JSON.stringify({
      cash: balances.cash,
      buying_power: balances.buying_power,
      equity: balances.equity,
      margin_requirement: balances.margin_requirement,
    }));
    
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Balances sync failed: ${errorMsg}`);
    console.error('[balancesSync] sync error', JSON.stringify({
      error: errorMsg,
    }));
    // Don't update timestamp on error - sync failed
    return result;
  }
}

