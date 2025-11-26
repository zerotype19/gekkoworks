/**
 * SAS v1 Broker Logging
 * 
 * Structured logging for all Tradier broker calls.
 * Logs are prefixed with [broker] for easy filtering via wrangler tail.
 * Also persists events to D1 for UI visibility.
 */

import type { Env } from '../env';
import type { TradingMode } from '../core/config';
import { insertBrokerEvent } from '../db/queries';

export interface BrokerLogContext {
  operation: 'GET_QUOTES' | 'GET_CHAINS' | 'PLACE_ORDER' | 'PLACE_SINGLE_LEG_ORDER' | 'GET_ORDER_STATUS' | 'GET_ORDER_WITH_LEGS' | 'GET_POSITIONS' | 'GET_BALANCES' | 'GET_ALL_ORDERS' | 'GET_OPEN_ORDERS' | 'GET_GAINLOSS' | 'CANCEL_ORDER' | 'GET_HISTORICAL_DATA';
  symbol?: string;
  expiration?: string;
  orderId?: string;
  statusCode?: number;
  ok?: boolean;
  durationMs?: number;
  errorMessage?: string;
  mode: TradingMode;
  strategy?: string; // Strategy ID (e.g., 'BULL_PUT_CREDIT', 'BEAR_PUT_DEBIT') for order-related operations
}

/**
 * Log a broker event
 * 
 * Outputs a single JSON line prefixed with [broker] for easy filtering:
 * wrangler tail | grep "[broker]"
 * 
 * Also persists to D1 for UI visibility. DB failures are swallowed to never block trading.
 */
export async function logBrokerEvent(env: Env, ctx: BrokerLogContext): Promise<void> {
  // Always log to console
  console.log('[broker]', JSON.stringify(ctx));

  // Also persist to DB, but never let failures block trading
  try {
    await insertBrokerEvent(env, ctx);
  } catch (err) {
    // Never let logging break trading
    console.warn('[broker] failed to persist broker event', err);
  }
}

