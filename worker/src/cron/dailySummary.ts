/**
 * Daily Activity Summary Cron
 * 
 * Runs at 4:15 PM ET (20:15 UTC) to generate and save daily trading activity summaries.
 * Summaries are stored in the daily_summaries table and can be viewed in the UI.
 */

import type { Env } from '../env';
import { insertDailySummary } from '../db/queries';
import { getETDateString, isTradingDay } from '../core/time';
import { generateDailySummaryData } from '../http/dailySummary';

/**
 * Run daily summary generation
 * 
 * Per system-interfaces.md:
 * export async function runDailySummary(env: Env, now: Date): Promise<void>;
 */
export async function runDailySummary(env: Env, now: Date): Promise<void> {
  try {
    // Only run on trading days
    if (!isTradingDay(now)) {
      console.log('[dailySummary] skipping - not a trading day', JSON.stringify({
        timestamp: now.toISOString(),
      }));
      return;
    }
    
    const dateET = getETDateString(now);
    
    console.log('[dailySummary] generating summary', JSON.stringify({
      date: dateET,
      timestamp: now.toISOString(),
    }));
    
    // Use shared function to generate summary data
    const summary = await generateDailySummaryData(env, now);
    
    // Save to database
    await insertDailySummary(env, dateET, summary);
    
    console.log('[dailySummary] summary generated and saved', JSON.stringify({
      date: dateET,
      trades_opened: summary.details.trades_opened.length,
      trades_closed: summary.details.trades_closed.length,
      proposals_total: summary.summary.proposals.total,
      realized_pnl: summary.summary.pnl.realized_today,
    }));
  } catch (error) {
    console.error('[dailySummary] error', JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }));
    // Don't throw - we don't want to break the cron if summary generation fails
  }
}
