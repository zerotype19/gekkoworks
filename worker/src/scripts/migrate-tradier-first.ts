/**
 * One-Time Migration Script: Realign D1 with Tradier
 * 
 * Per Tradier-first spec: This script wipes/archives existing OPEN trades
 * and recreates them from raw Tradier positions.
 * 
 * Run this ONCE to establish Tradier as the source of truth.
 * 
 * Usage:
 *   POST /debug/migrate-tradier-first
 */

import type { Env } from '../env';
import { TradierClient } from '../broker/tradierClient';
import { getAllTrades, updateTrade, insertTrade } from '../db/queries';
import type { TradeRow } from '../types';
import { groupPositionsIntoSpreads } from '../engine/portfolioSync';

interface MigrationResult {
  timestamp: string;
  archived_count: number;
  created_count: number;
  spreads_found: number;
  errors: string[];
  summary: {
    before_open_trades: number;
    after_open_trades: number;
    tradier_positions: number;
  };
}

export async function runTradierFirstMigration(env: Env): Promise<MigrationResult> {
  const now = new Date();
  const result: MigrationResult = {
    timestamp: now.toISOString(),
    archived_count: 0,
    created_count: 0,
    spreads_found: 0,
    errors: [],
    summary: {
      before_open_trades: 0,
      after_open_trades: 0,
      tradier_positions: 0,
    },
  };
  
  try {
    const broker = new TradierClient(env);
    
    // 1. Fetch all existing OPEN trades
    const allTrades = await getAllTrades(env);
    const openTrades = allTrades.filter(t => t.status === 'OPEN');
    result.summary.before_open_trades = openTrades.length;
    
    // 2. Archive/close all existing OPEN trades
    for (const trade of openTrades) {
      try {
        await updateTrade(env, trade.id, {
          status: 'CLOSED',
          exit_reason: 'UNKNOWN',
          closed_at: now.toISOString(),
        });
        result.archived_count++;
      } catch (error) {
        const errorMsg = `Failed to archive trade ${trade.id}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        console.error('[migration] archive error', JSON.stringify({ trade_id: trade.id, error: errorMsg }));
      }
    }
    
    // 3. Fetch all positions from Tradier
    const tradierPositions = await broker.getPositions();
    result.summary.tradier_positions = tradierPositions.length;
    
    if (tradierPositions.length === 0) {
      console.log('[migration] no positions in Tradier, migration complete');
      result.summary.after_open_trades = 0;
      return result;
    }
    
    // 4. Group positions into spreads
    const spreads = groupPositionsIntoSpreads(tradierPositions);
    result.spreads_found = spreads.length;
    
    if (spreads.length === 0) {
      console.log('[migration] no valid BPCS spreads found in Tradier positions');
      result.summary.after_open_trades = 0;
      return result;
    }
    
    // 5. Create trade records from Tradier spreads
    for (const spread of spreads) {
      try {
        // Calculate entry_price from cost_basis
        let entryPrice: number | null = null;
        if (spread.short_cost_basis !== null && spread.long_cost_basis !== null) {
          const shortCreditTotal = Math.abs(spread.short_cost_basis);
          const longDebitTotal = Math.abs(spread.long_cost_basis);
          const netCreditTotal = shortCreditTotal - longDebitTotal;
          const quantity = spread.short_quantity;
          if (quantity > 0) {
            entryPrice = netCreditTotal / 100 / quantity;
          }
        }
        
        const newTrade: Omit<TradeRow, 'created_at' | 'updated_at'> = {
          id: crypto.randomUUID(),
          proposal_id: null,
          symbol: spread.symbol,
          expiration: spread.expiration,
          short_strike: spread.short_strike,
          long_strike: spread.long_strike,
          width: spread.short_strike - spread.long_strike,
          quantity: spread.short_quantity,
          entry_price: entryPrice,
          exit_price: null,
          max_profit: entryPrice ? entryPrice * spread.short_quantity : null,
          max_loss: entryPrice ? (spread.short_strike - spread.long_strike - entryPrice) * spread.short_quantity : null,
          status: 'OPEN',
          exit_reason: null,
          broker_order_id_open: null, // Will be linked by orderSync if matching order found
          broker_order_id_close: null,
          opened_at: now.toISOString(),
          closed_at: null,
          realized_pnl: null,
        };
        
        await insertTrade(env, newTrade);
        result.created_count++;
        
        console.log('[migration] created trade from Tradier position', JSON.stringify({
          tradeId: newTrade.id,
          symbol: spread.symbol,
          expiration: spread.expiration,
          short_strike: spread.short_strike,
          long_strike: spread.long_strike,
          quantity: spread.short_quantity,
          entry_price: entryPrice,
        }));
      } catch (error) {
        const errorMsg = `Failed to create trade for ${spread.symbol} ${spread.expiration}: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(errorMsg);
        console.error('[migration] create error', JSON.stringify({ spread, error: errorMsg }));
      }
    }
    
    // 6. Count final open trades
    const finalTrades = await getAllTrades(env);
    result.summary.after_open_trades = finalTrades.filter(t => t.status === 'OPEN').length;
    
    console.log('[migration] migration complete', JSON.stringify(result.summary));
    
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Migration failed: ${errorMsg}`);
    console.error('[migration] fatal error', JSON.stringify({ error: errorMsg }));
    return result;
  }
}

