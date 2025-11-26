/**
 * Test script to manually trigger proposal generation
 * 
 * Run with: npx tsx test-proposal.ts
 * 
 * This will test:
 * - Tradier API connectivity
 * - Proposal generation logic
 * - Error handling
 */

import { generateProposal } from './src/engine/proposals';

// Mock Env for testing
// In real usage, this comes from Cloudflare Worker
const mockEnv = {
  DB: {} as any, // Will need actual D1 binding for real test
  TRADIER_ENV: 'sandbox' as const,
  TRADIER_API_TOKEN: process.env.TRADIER_API_TOKEN || '',
  TRADIER_ACCOUNT_ID: process.env.TRADIER_ACCOUNT_ID || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
};

async function testProposal() {
  console.log('🧪 Testing proposal generation...\n');
  console.log('Environment:', mockEnv.TRADIER_ENV);
  console.log('API Token:', mockEnv.TRADIER_API_TOKEN ? '✅ Set' : '❌ Missing');
  console.log('Account ID:', mockEnv.TRADIER_ACCOUNT_ID ? '✅ Set' : '❌ Missing');
  console.log('');

  try {
    const now = new Date();
    console.log('Current time:', now.toISOString());
    console.log('');

    const result = await generateProposal(mockEnv, now);

    if (result.proposal) {
      console.log('✅ Proposal generated successfully!');
      console.log('Proposal ID:', result.proposal.id);
      console.log('Symbol:', result.proposal.symbol);
      console.log('Expiration:', result.proposal.expiration);
      console.log('Short Strike:', result.proposal.short_strike);
      console.log('Long Strike:', result.proposal.long_strike);
      console.log('Credit Target:', result.proposal.credit_target);
      console.log('Score:', result.proposal.score);
    } else {
      console.log('ℹ️  No proposal generated (no valid candidates found)');
      console.log('This is normal if:');
      console.log('  - Market conditions don\'t meet criteria');
      console.log('  - No expirations in 30-35 DTE range');
      console.log('  - All candidates filtered out by hard filters');
    }
  } catch (error) {
    console.error('❌ Error during proposal generation:');
    console.error(error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

testProposal();

