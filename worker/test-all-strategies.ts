/**
 * Comprehensive test script to validate all strategies generate proposals
 * 
 * Run with: npx tsx test-all-strategies.ts
 * 
 * This script:
 * - Calls the deployed worker's proposal generation 5 times
 * - Validates all 4 strategies can generate proposals
 * - Verifies scores are calculated correctly
 * - Reports results for each strategy
 */

const WORKER_URL = 'https://gekkoworks-api.kevin-mcgovern.workers.dev';

interface ProposalResult {
  success: boolean;
  proposal?: {
    id: string;
    symbol: string;
    strategy: string;
    short_strike: number;
    long_strike: number;
    credit_target: number;
    score: number;
    expiration: string;
  };
  candidate?: {
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    credit: number;
    score: number;
  };
  connectivity?: {
    success: boolean;
    error?: string;
  };
  error?: string;
}

interface StrategyResults {
  BULL_PUT_CREDIT: { count: number; proposals: any[] };
  BEAR_CALL_CREDIT: { count: number; proposals: any[] };
  BULL_CALL_DEBIT: { count: number; proposals: any[] };
  BEAR_PUT_DEBIT: { count: number; proposals: any[] };
}

async function testProposalGeneration(runNumber: number): Promise<ProposalResult> {
  console.log(`\n🔄 Test Run ${runNumber}/5`);
  console.log('─'.repeat(50));
  
  try {
    const response = await fetch(`${WORKER_URL}/test/proposal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${text}`,
      };
    }

    const result: ProposalResult = await response.json();
    
    if (result.success && result.proposal) {
      const proposal = result.proposal;
      console.log(`✅ Proposal Generated:`);
      console.log(`   Strategy: ${proposal.strategy}`);
      console.log(`   Symbol: ${proposal.symbol}`);
      console.log(`   Spread: ${proposal.short_strike}/${proposal.long_strike} (${Math.abs(proposal.short_strike - proposal.long_strike)}pt)`);
      console.log(`   Credit/Debit: $${proposal.credit_target.toFixed(2)}`);
      console.log(`   Score: ${(proposal.score * 100).toFixed(2)}%`);
      console.log(`   Expiration: ${proposal.expiration}`);
    } else if (result.success && result.candidate) {
      const candidate = result.candidate;
      console.log(`ℹ️  Candidate Generated (not saved as proposal):`);
      console.log(`   Symbol: ${candidate.symbol}`);
      console.log(`   Spread: ${candidate.short_strike}/${candidate.long_strike}`);
      console.log(`   Credit: $${candidate.credit.toFixed(2)}`);
      console.log(`   Score: ${(candidate.score * 100).toFixed(2)}%`);
    } else {
      console.log(`ℹ️  No proposal generated (no valid candidates found)`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    }

    if (result.connectivity) {
      if (result.connectivity.success) {
        console.log(`✅ Tradier connectivity: OK`);
      } else {
        console.log(`⚠️  Tradier connectivity: ${result.connectivity.error}`);
      }
    }

    return result;
  } catch (error) {
    console.error(`❌ Error in test run ${runNumber}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getRecentProposals(): Promise<any[]> {
  try {
    const response = await fetch(`${WORKER_URL}/v2/proposals-and-orders`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`⚠️  Could not fetch proposals: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.proposals || [];
  } catch (error) {
    console.warn(`⚠️  Error fetching proposals:`, error);
    return [];
  }
}

async function runTests() {
  console.log('🧪 Testing All Strategy Proposal Generation');
  console.log('='.repeat(50));
  console.log(`Worker URL: ${WORKER_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  const results: ProposalResult[] = [];
  const strategyResults: StrategyResults = {
    BULL_PUT_CREDIT: { count: 0, proposals: [] },
    BEAR_CALL_CREDIT: { count: 0, proposals: [] },
    BULL_CALL_DEBIT: { count: 0, proposals: [] },
    BEAR_PUT_DEBIT: { count: 0, proposals: [] },
  };

  // Run 5 test scenarios
  for (let i = 1; i <= 5; i++) {
    const result = await testProposalGeneration(i);
    results.push(result);

    // Track by strategy
    if (result.proposal?.strategy) {
      const strategy = result.proposal.strategy as keyof StrategyResults;
      if (strategy in strategyResults) {
        strategyResults[strategy].count++;
        strategyResults[strategy].proposals.push(result.proposal);
      }
    }

    // Wait 2 seconds between runs to avoid rate limiting
    if (i < 5) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Get recent proposals from database
  console.log('\n📊 Fetching recent proposals from database...');
  const recentProposals = await getRecentProposals();
  
  // Count strategies in recent proposals
  const recentStrategyCounts: Record<string, number> = {};
  recentProposals.forEach((p: any) => {
    if (p.strategy) {
      recentStrategyCounts[p.strategy] = (recentStrategyCounts[p.strategy] || 0) + 1;
    }
  });

  // Summary Report
  console.log('\n' + '='.repeat(50));
  console.log('📋 SUMMARY REPORT');
  console.log('='.repeat(50));

  console.log('\n✅ Test Runs Completed: 5/5');
  const successfulRuns = results.filter(r => r.success).length;
  console.log(`   Successful: ${successfulRuns}/5`);
  console.log(`   Failed: ${5 - successfulRuns}/5`);

  console.log('\n📈 Strategy Proposal Counts (from test runs):');
  console.log(`   BULL_PUT_CREDIT:  ${strategyResults.BULL_PUT_CREDIT.count}`);
  console.log(`   BEAR_CALL_CREDIT: ${strategyResults.BEAR_CALL_CREDIT.count}`);
  console.log(`   BULL_CALL_DEBIT:  ${strategyResults.BULL_CALL_DEBIT.count}`);
  console.log(`   BEAR_PUT_DEBIT:   ${strategyResults.BEAR_PUT_DEBIT.count}`);

  if (Object.keys(recentStrategyCounts).length > 0) {
    console.log('\n📊 Recent Proposals in Database:');
    Object.entries(recentStrategyCounts).forEach(([strategy, count]) => {
      console.log(`   ${strategy}: ${count}`);
    });
  }

  // Validate all strategies
  console.log('\n🔍 Strategy Validation:');
  const allStrategies = ['BULL_PUT_CREDIT', 'BEAR_CALL_CREDIT', 'BULL_CALL_DEBIT', 'BEAR_PUT_DEBIT'];
  let allStrategiesValid = true;

  allStrategies.forEach(strategy => {
    const testRunCount = strategyResults[strategy as keyof StrategyResults].count;
    const dbCount = recentStrategyCounts[strategy] || 0;
    const hasProposals = testRunCount > 0 || dbCount > 0;
    
    if (hasProposals) {
      console.log(`   ✅ ${strategy}: Generated proposals`);
    } else {
      console.log(`   ⚠️  ${strategy}: No proposals generated (may need different market conditions)`);
      allStrategiesValid = false;
    }
  });

  // Score validation
  console.log('\n🎯 Score Validation:');
  let allScoresValid = true;
  results.forEach((result, index) => {
    if (result.proposal) {
      const score = result.proposal.score;
      if (score >= 0 && score <= 1) {
        console.log(`   ✅ Run ${index + 1}: Score ${(score * 100).toFixed(2)}% (valid)`);
      } else {
        console.log(`   ❌ Run ${index + 1}: Score ${score} (invalid range)`);
        allScoresValid = false;
      }
    }
  });

  // Final verdict
  console.log('\n' + '='.repeat(50));
  if (allStrategiesValid && allScoresValid && successfulRuns === 5) {
    console.log('✅ ALL TESTS PASSED');
    console.log('   All strategies can generate proposals');
    console.log('   All scores are valid');
    console.log('   System is ready for market hours');
  } else {
    console.log('⚠️  SOME ISSUES DETECTED');
    if (!allStrategiesValid) {
      console.log('   - Some strategies did not generate proposals');
      console.log('   - This may be normal if market conditions do not meet criteria');
    }
    if (!allScoresValid) {
      console.log('   - Some scores are outside valid range (0-1)');
    }
    if (successfulRuns < 5) {
      console.log(`   - ${5 - successfulRuns} test runs failed`);
    }
  }
  console.log('='.repeat(50));
}

// Run tests
runTests().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

