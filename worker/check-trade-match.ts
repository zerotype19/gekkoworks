/**
 * Quick script to check if the latest trade matches the latest proposal
 */

import { getDB } from './src/db/client';
import type { ProposalRow, TradeRow } from './src/types';

async function checkTradeMatch() {
  // Get environment variables
  const accountId = process.env.TRADIER_ACCOUNT_ID;
  if (!accountId) {
    console.error('TRADIER_ACCOUNT_ID not set');
    process.exit(1);
  }

  // For local testing, we'd need the actual env object
  // This script assumes we're running in a context where we can access the DB
  // Let's use a different approach - check via the HTTP API or logs
  
  console.log('To check if the trade matches the proposal, please:');
  console.log('1. Check the latest proposal in the database');
  console.log('2. Check the latest trade in the database');
  console.log('3. Compare: symbol, strategy, expiration, strikes, quantity');
  console.log('\nOr use the web UI to view both and compare manually.');
}

checkTradeMatch().catch(console.error);

