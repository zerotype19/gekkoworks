/**
 * Script to check order placement status and rejections
 * Analyzes broker events and system logs to see if proposals are being submitted as orders
 */

import { getDB } from './src/db/client';
import type { BrokerEventRow, SystemLogRow } from './src/types';

async function checkOrderStatus() {
  console.log('🔍 Checking order placement status...\n');

  // This script needs to run in the worker context with env
  // For now, let's create a query that can be run via the API or manually
  
  console.log('To check order status, query the following endpoints:');
  console.log('\n1. GET /broker-events?limit=100');
  console.log('   - Shows all broker API calls including PLACE_ORDER operations');
  console.log('   - Check for ok: false to see failures');
  console.log('   - Filter by operation: "PLACE_ORDER"');
  
  console.log('\n2. GET /proposals-and-orders?limit=50');
  console.log('   - Shows proposals with their order outcomes');
  console.log('   - Check outcome: "FILLED", "REJECTED", "PENDING"');
  console.log('   - Check rejectionReasons array for details');
  
  console.log('\n3. Check system logs for:');
  console.log('   - "[entry][rejected]" - Entry attempts that were rejected');
  console.log('   - "[broker][placeSpreadOrder][error]" - Order placement errors');
  console.log('   - "[entry] order placed successfully" - Successful placements');
  
  console.log('\n4. Filter by strategy:');
  console.log('   - BEAR_PUT_DEBIT');
  console.log('   - BULL_CALL_CREDIT');
  
  console.log('\n💡 You can also check the web UI at:');
  console.log('   - Proposals and Orders page');
  console.log('   - Broker Activity page');
}

checkOrderStatus().catch(console.error);

