/**
 * SAS v1 Worker Entrypoint
 * 
 * Main entry point for Cloudflare Worker.
 * Routes HTTP requests and scheduled cron events.
 * Per architecture.md and system-interfaces.md.
 */

import type { Env } from './env';

// HTTP handlers
import { handleHealth } from './http/health';
import { handleStatus } from './http/status';
import { handleTrades, handleTradeDetail } from './http/trades';
import { handleRiskState } from './http/risk';
import { handleBrokerEventsRequest } from './http/brokerEvents';
import { handleDebugPnl } from './http/debugPnl';
import { handleDebugPnlSummary } from './http/debugPnlSummary';
import { handleDebugPositions } from './http/debugPositions';
import { handleDebugScoring } from './http/debugScoring';
import { handleDebugHealthDb } from './http/debugHealthDb';
import { handleDebugForceExit } from './http/debugForceExit';
import { handleDebugTestClosePosition } from './http/debugTestClosePosition';
import { handleDebugExitRules } from './http/debugExitRules';
import { handleDebugExitPayload } from './http/debugExitPayload';
import { handleDebugTradierSnapshot } from './http/debugTradierSnapshot';
import { handleDebugCreateTestTrade } from './http/debugCreateTestTrade';
import { handleDebugInitExitRules } from './http/debugInitExitRules';
import { handleDebugSystemMode } from './http/debugSystemMode';
import { handleDashboardSummary } from './http/dashboardSummary';
import { handleDebugHealth } from './http/debugHealth';
import { handleDebugAutoConfig } from './http/debugAutoConfig';
import { handleDebugStrategyConfig } from './http/debugStrategyConfig';
import { handleDebugAutoReadiness } from './http/debugAutoReadiness';
import { handleDebugProposals } from './http/debugProposals';
import { handleProposalsAndOrders } from './http/proposalsAndOrders';
import { handleDebugOrderStatus } from './http/debugOrderStatus';
import { handleAdminRepairPortfolio } from './http/adminRepairPortfolio';
import { handleAdminReconcile } from './http/adminReconcile';
import { handleAdminGetSettings, handleAdminUpdateSetting } from './http/adminSettings';
import { handleDebugPortfolioSync } from './http/debugPortfolioSync';
import { handlePortfolioPositions } from './http/portfolioPositions';
import { handleDebugUpdateQuantities } from './http/debugUpdateQuantities';
import { handleDebugBackfillEntryPrices } from './http/debugBackfillEntryPrices';
import { handleDebugBackfillMissingTrades } from './http/debugBackfillMissingTrades';
import { handleDebugBackfillExitPrices } from './http/debugBackfillExitPrices';
import { handleDebugCompareTradierClosed } from './http/debugCompareTradierClosed';
import { handleDebugAnalyzeTradesVsTradier } from './http/debugAnalyzeTradesVsTradier';
import { handleDebugAnalyzeTradesDetailed } from './http/debugAnalyzeTradesDetailed';
import { handleDebugComparePortfolioPositions } from './http/debugComparePortfolioPositions';
import { handleDebugCleanupStalePositions } from './http/debugCleanupStalePositions';
import { handleDebugForcePortfolioSync } from './http/debugForcePortfolioSync';
import { handleDebugTradeHistory } from './http/debugTradeHistory';
import { handleDebugBrokerEvents } from './http/debugBrokerEvents';
import { handleDebugTableSchema } from './http/debugTableSchema';
import { handleDebugRegime } from './http/debugRegime';
import { handleDebugStrategyStatus } from './http/debugStrategyStatus';
import { handleDebugLiveSignals } from './http/debugLiveSignals';
import { handleDebugRegimeConfidence } from './http/debugRegimeConfidence';
import { handleDebugMarkTradeClosed } from './http/debugMarkTradeClosed';
import { handleDebugTradeCycleStatus } from './http/debugTradeCycleStatus';
import { handleDebugCleanupPriceSnaps } from './http/debugCleanupPriceSnaps';
import { handleDebugRemoveStrategyWhitelist } from './http/debugRemoveStrategyWhitelist';
import { handleDebugEnableAutoMode } from './http/debugEnableAutoMode';
import { handleDebugRemoveSymbolWhitelist } from './http/debugRemoveSymbolWhitelist';
import { handleDebugSetConcentrationLimits } from './http/debugSetConcentrationLimits';
import { handleDebugConcentration } from './http/debugConcentration';
import { handleDebugStrategyInvariants } from './http/debugStrategyInvariants';
import { handleDebugFixTradeStrategies } from './http/debugFixTradeStrategies';
import { handleDebugTraceOrder } from './http/debugTraceOrder';
import { handleDebugTraceExitAttempts } from './http/debugTraceExitAttempts';
import { handleDebugInvestigateIssues } from './http/debugInvestigateIssues';
import { handleDebugSyncPendingOrders } from './http/debugSyncPendingOrders';
import { handleDebugVerifyPositionsMonitoring } from './http/debugVerifyPositionsMonitoring';
import { handleDebugTestMonitoringWithPortfolio } from './http/debugTestMonitoringWithPortfolio';
import { handleDebugSyncTradeQuantities } from './http/debugSyncTradeQuantities';
import { handleDebugWhyNoProposals } from './http/debugWhyNoProposals';
import { handleDebugDailyRecap } from './http/debugDailyRecap';
import { handleDebugInvestigateEmergencyExits } from './http/debugInvestigateEmergencyExits';
import { handleDailySummary } from './http/dailySummary';
import { handleDebugDoubleDailyLimits } from './http/debugDoubleDailyLimits';

// Cron handlers
import { runPremarketCheck } from './cron/premarket';
import { runTradeCycle } from './cron/tradeCycle';
import { runMonitorCycle } from './cron/monitorCycle';
import { runAccountSync } from './cron/accountSync';
import { runOrphanedOrderCleanup } from './cron/orphanedOrderCleanup';
import { runDailySummary } from './cron/dailySummary';

// Test handlers
async function handleTestProposal(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const { generateProposal } = await import('./engine/proposals');
    const { TradierClient } = await import('./broker/tradierClient');
    
    const now = new Date();
    const broker = new TradierClient(env);
    
    // Test basic connectivity first
    let connectivityTest = { success: false, error: '' };
    try {
      const quote = await broker.getUnderlyingQuote('SPY');
      connectivityTest = { success: true, error: '' };
    } catch (err) {
      connectivityTest = { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
    
    // Try to generate proposal
    const result = await generateProposal(env, now);
    
    return new Response(
      JSON.stringify({
        success: true,
        connectivity: connectivityTest,
        proposal: result.proposal,
        candidate: result.candidate ? {
          symbol: result.candidate.symbol,
          expiration: result.candidate.expiration,
          short_strike: result.candidate.short_strike,
          long_strike: result.candidate.long_strike,
          credit: result.candidate.credit,
          score: result.candidate.scoring.composite_score,
        } : null,
        timestamp: now.toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
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

async function handleTestTradeCycle(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const now = new Date();
    await runTradeCycle(env, now);
    
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Trade cycle completed',
        timestamp: now.toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
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

async function handleTestPortfolioSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const { syncPortfolioFromTradier } = await import('./engine/portfolioSync');
    const result = await syncPortfolioFromTradier(env);
    
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Portfolio sync completed',
        result,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
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

async function handleTestOrderSync(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const { syncOrdersFromTradier } = await import('./engine/orderSync');
    const result = await syncOrdersFromTradier(env);
    
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Order sync completed',
        result,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
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

async function handleDebugMonitor(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const now = new Date();
  console.log('[monitor] debug_invoke', { now: now.toISOString(), source: 'HTTP' });

  await runMonitorCycle(env, now);

  return new Response(
    JSON.stringify({ ok: true, ranAt: now.toISOString() }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleTestResetRiskState(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const { setRiskState, getRiskState } = await import('./db/queries');
    const { getRiskSnapshot } = await import('./core/risk');
    const { setSystemMode } = await import('./core/systemMode');
    
    const now = new Date();
    const before = await getRiskSnapshot(env, now);
    
    // 1. Reset risk state to NORMAL
    await setRiskState(env, 'RISK_STATE', 'NORMAL');
    
    // 2. Reset SYSTEM_MODE to NORMAL (even if it was HARD_STOP, since we've investigated)
    await setSystemMode(env, 'NORMAL', 'MANUAL_RESET_AFTER_INVESTIGATION', {
      previous_mode: before.system_mode,
      previous_risk_state: before.risk_state,
      emergency_exit_count_before: before.emergency_exit_count_today,
      investigation_result: 'FALSE_POSITIVES_FROM_MIGRATION',
    });
    
    // 3. Clear emergency exit count
    await setRiskState(env, 'EMERGENCY_EXIT_COUNT_TODAY', '0');
    
    // 4. Clear emergency exit timestamp if it exists
    await setRiskState(env, 'EMERGENCY_EXIT_LAST_TIMESTAMP', '');
    
    const after = await getRiskSnapshot(env, now);
    
    console.log('[system][risk][reset]', JSON.stringify({
      before,
      after,
      timestamp: now.toISOString(),
    }));
    
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Risk state reset to NORMAL (trades preserved)',
        before,
        after,
        timestamp: now.toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
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

/**
 * CORS headers for all responses
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * Add CORS headers to a response
 */
function addCorsHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });
  return newResponse;
}

/**
 * Handle CORS preflight requests
 */
function handleCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/**
 * Worker export
 * 
 * Per system-interfaces.md:
 * export default {
 *   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
 *   async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void>
 * }
 */
export default {
  /**
   * Handle HTTP requests (read-only endpoints)
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    const url = new URL(request.url);
    const path = url.pathname;
    
    let response: Response;
    
    // Route HTTP endpoints
    if (path === '/health' && request.method === 'GET') {
      response = await handleHealth(request, env, ctx);
    } else if (path === '/status' && request.method === 'GET') {
      response = await handleStatus(request, env, ctx);
    } else if (path === '/dashboard/summary' && request.method === 'GET') {
      response = await handleDashboardSummary(request, env, ctx);
    } else if (path === '/trades' && request.method === 'GET') {
      response = await handleTrades(request, env, ctx);
    } else if (path.match(/^\/trades\/([^\/]+)$/) && request.method === 'GET') {
      const tradeId = path.match(/^\/trades\/([^\/]+)$/)?.[1];
      if (tradeId) {
        response = await handleTradeDetail(request, env, ctx, tradeId);
      } else {
        response = new Response(
          JSON.stringify({ error: 'Invalid trade ID' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    } else if (path === '/risk-state' && request.method === 'GET') {
      response = await handleRiskState(request, env, ctx);
    } else if (path === '/broker-events' && request.method === 'GET') {
      response = await handleBrokerEventsRequest(request, env);
    } else if (path === '/debug/pnl' && request.method === 'GET') {
      response = await handleDebugPnl(request, env);
    } else if (path === '/debug/pnl-summary' && request.method === 'GET') {
      response = await handleDebugPnlSummary(request, env);
    } else if (path === '/debug/positions' && request.method === 'GET') {
      response = await handleDebugPositions(request, env);
    } else if (path === '/debug/scoring' && request.method === 'POST') {
      // Debug endpoint to score synthetic candidates
      response = await handleDebugScoring(request, env);
    } else if (path === '/debug/health/db' && request.method === 'GET') {
      // DB health check endpoint
      response = await handleDebugHealthDb(request, env);
    } else if (path === '/v2/debug/health' && request.method === 'GET') {
      // Comprehensive health/diagnostic endpoint
      response = await handleDebugHealth(request, env);
    } else if (path === '/v2/debug/auto-config' && request.method === 'GET') {
      // Auto mode configuration endpoint
      response = await handleDebugAutoConfig(request, env);
    } else if (path === '/v2/debug/strategy-config' && request.method === 'GET') {
      // Strategy configuration endpoint (DTE, delta, credit, symbols)
      response = await handleDebugStrategyConfig(request, env);
    } else if (path === '/v2/debug/proposals' && request.method === 'GET') {
      // Last N scored proposals and failure analysis
      response = await handleDebugProposals(request, env);
    } else if (path === '/v2/proposals-and-orders' && request.method === 'GET') {
      // Proposals with orders and broker responses
      response = await handleProposalsAndOrders(request, env);
    } else if (path === '/debug/order-status' && request.method === 'GET') {
      // Analyze order placement status and rejections by strategy
      response = await handleDebugOrderStatus(request, env);
    } else if (path === '/v2/debug/auto-readiness' && request.method === 'GET') {
      // Auto mode readiness check endpoint
      response = await handleDebugAutoReadiness(request, env);
    } else if (path === '/debug/regime' && request.method === 'GET') {
      // Regime detection and status endpoint
      response = await handleDebugRegime(env);
    } else if (path === '/debug/strategy-status' && request.method === 'GET') {
      // Strategy status and exposure endpoint
      response = await handleDebugStrategyStatus(env);
    } else if (path === '/debug/live-signals' && request.method === 'GET') {
      // Live market signals endpoint (SMA, VIX, ATR, momentum, volatility)
      response = await handleDebugLiveSignals(env);
    } else if (path === '/debug/regime-confidence' && request.method === 'GET') {
      // Regime confidence metric and trading recommendation
      response = await handleDebugRegimeConfidence(env);
    } else if (path === '/v2/admin/repair-portfolio' && request.method === 'POST') {
      // Manual repair portfolio endpoint
      response = await handleAdminRepairPortfolio(request, env);
    } else if (path === '/v2/admin/reconcile' && (request.method === 'POST' || request.method === 'GET')) {
      // Reconciliation endpoint (Tradier vs local DB) - supports both GET and POST
      response = await handleAdminReconcile(request, env);
    } else if (path === '/v2/admin/settings' && request.method === 'GET') {
      // Get all system settings
      response = await handleAdminGetSettings(request, env);
    } else if (path === '/v2/admin/settings' && request.method === 'POST') {
      // Update a system setting
      response = await handleAdminUpdateSetting(request, env);
    } else if (path.match(/^\/debug\/force-exit\/([^\/]+)$/) && request.method === 'POST') {
      // Force exit for a specific trade (bypasses exit rules)
      const tradeId = path.match(/^\/debug\/force-exit\/([^\/]+)$/)?.[1];
      if (tradeId) {
        response = await handleDebugForceExit(request, env, tradeId);
      } else {
        response = new Response(
          JSON.stringify({ error: 'Invalid trade ID' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } else if (path === '/debug/test-close-position' && request.method === 'POST') {
      // Test closing a position directly via Tradier
      response = await handleDebugTestClosePosition(request, env);
    } else if (path === '/debug/mark-trade-closed' && request.method === 'POST') {
      // Manual close endpoint - marks trade as closed without placing orders (SANDBOX_PAPER only)
      response = await handleDebugMarkTradeClosed(request, env, ctx);
    } else if (path === '/debug/trade-cycle-status' && request.method === 'GET') {
      // Check trade cycle status and blockers
      response = await handleDebugTradeCycleStatus(request, env, ctx);
    } else if (path === '/debug/cleanup-price-snaps' && (request.method === 'GET' || request.method === 'POST')) {
      // Clean up price snap entries from settings table
      response = await handleDebugCleanupPriceSnaps(request, env, ctx);
    } else if (path === '/debug/remove-strategy-whitelist' && request.method === 'POST') {
      // Remove strategy whitelist to allow all strategies (SANDBOX_PAPER only)
      response = await handleDebugRemoveStrategyWhitelist(request, env, ctx);
    } else if (path === '/debug/remove-symbol-whitelist' && request.method === 'POST') {
      // Remove symbol whitelist to allow all eligible symbols (SANDBOX_PAPER only)
      response = await handleDebugRemoveSymbolWhitelist(request, env, ctx);
    } else if (path === '/debug/set-concentration-limits' && (request.method === 'GET' || request.method === 'POST')) {
      // Initialize concentration limit settings with defaults
      response = await handleDebugSetConcentrationLimits(env);
    } else if (path === '/debug/double-daily-limits' && (request.method === 'GET' || request.method === 'POST')) {
      // Double all daily limits for testing
      response = await handleDebugDoubleDailyLimits(request, env);
    } else if (path === '/debug/concentration' && request.method === 'GET') {
      // Debug endpoint to show current concentration state for all symbols
      response = await handleDebugConcentration(env);
    } else if (path === '/debug/strategy-invariants' && request.method === 'GET') {
      // Debug endpoint to audit strategy invariants across all trades
      response = await handleDebugStrategyInvariants(request, env);
    } else if (path === '/debug/fix-trade-strategies' && request.method === 'GET') {
      // Fix trades with incorrect strategies (matches to proposals)
      response = await handleDebugFixTradeStrategies(request, env);
    } else if (path === '/debug/trace-order' && request.method === 'GET') {
      // Trace order from proposal through fill to trade
      response = await handleDebugTraceOrder(request, env);
    } else if (path === '/debug/trace-exit-attempts' && request.method === 'GET') {
      // Trace all exit attempts for a trade
      response = await handleDebugTraceExitAttempts(request, env);
    } else if (path === '/debug/investigate-issues' && request.method === 'GET') {
      // Investigate monitoring, order sync, and proposal invalidation issues
      response = await handleDebugInvestigateIssues(request, env);
    } else if (path === '/debug/sync-pending-orders' && request.method === 'GET') {
      // Manually sync orders that are out of sync with Tradier
      response = await handleDebugSyncPendingOrders(request, env);
    } else if (path === '/debug/verify-positions-monitoring' && request.method === 'GET') {
      // Verify all Tradier positions are being monitored
      response = await handleDebugVerifyPositionsMonitoring(request, env);
    } else if (path === '/debug/test-monitoring-with-portfolio' && request.method === 'GET') {
      // Test if monitoring can find portfolio positions for trades
      response = await handleDebugTestMonitoringWithPortfolio(request, env);
    } else if (path === '/debug/sync-trade-quantities' && request.method === 'GET') {
      // Sync trade quantities from portfolio positions
      response = await handleDebugSyncTradeQuantities(request, env);
    } else if (path === '/debug/why-no-proposals' && request.method === 'GET') {
      // Debug endpoint to diagnose why no proposals were generated today
      response = await handleDebugWhyNoProposals(request, env);
    } else if (path === '/debug/enable-auto-mode' && (request.method === 'GET' || request.method === 'POST')) {
      // Check and enable auto mode
      response = await handleDebugEnableAutoMode(request, env, ctx);
    } else if (path === '/debug/exit-rules' && request.method === 'GET') {
      // View all exit rule config values
      response = await handleDebugExitRules(request, env);
    } else if (path.match(/^\/debug\/exit\/([^\/]+)$/) && request.method === 'GET') {
      // Inspect exit order payload for a trade
      const tradeId = path.match(/^\/debug\/exit\/([^\/]+)$/)?.[1];
      if (tradeId) {
        response = await handleDebugExitPayload(request, env, ctx);
      } else {
        response = new Response(
          JSON.stringify({ error: 'Invalid trade ID' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } else if (path === '/debug/tradier/snapshot' && request.method === 'GET') {
      // Inspect latest Tradier snapshot or trigger new sync
      response = await handleDebugTradierSnapshot(request, env, ctx);
    } else if (path === '/debug/create-test-trade' && request.method === 'POST') {
      // Create a test OPEN trade for testing exit functionality
      response = await handleDebugCreateTestTrade(request, env);
    } else if (path === '/debug/init-exit-rules' && request.method === 'POST') {
      // Initialize exit rule settings with defaults
      response = await handleDebugInitExitRules(request, env);
    } else if (path === '/debug/system-mode' && (request.method === 'GET' || request.method === 'POST')) {
      // View or change system mode
      response = await handleDebugSystemMode(request, env);
    } else if (path === '/test/proposal' && request.method === 'POST') {
      // Test endpoint to manually trigger proposal generation
      response = await handleTestProposal(request, env, ctx);
    } else if (path === '/test/trade-cycle' && request.method === 'POST') {
      // Test endpoint to manually trigger trade cycle
      response = await handleTestTradeCycle(request, env, ctx);
    } else if (path === '/test/portfolio-sync' && request.method === 'POST') {
      // Test endpoint to manually trigger portfolio sync
      response = await handleTestPortfolioSync(request, env, ctx);
    } else if (path === '/test/order-sync' && request.method === 'POST') {
      // Test endpoint to manually trigger order sync
      response = await handleTestOrderSync(request, env, ctx);
    } else if (path === '/test/reset-risk-state' && request.method === 'POST') {
      // Test endpoint to reset risk state to NORMAL
      response = await handleTestResetRiskState(request, env, ctx);
    } else if (path === '/debug/monitor' && request.method === 'GET') {
      // Debug endpoint to manually trigger a monitor cycle
      response = await handleDebugMonitor(request, env, ctx);
    } else if (path === '/portfolio-positions' && request.method === 'GET') {
      // Read-only endpoint to get portfolio positions
      response = await handlePortfolioPositions(request, env);
    } else if ((path === '/daily-summary' || path === '/v2/daily-summary') && (request.method === 'GET' || request.method === 'POST')) {
      // Daily activity summary endpoint - generate and retrieve summaries
      response = await handleDailySummary(request, env, ctx);
    } else if (path === '/debug/portfolio-sync' && request.method === 'GET') {
      // Debug endpoint to test portfolio sync and show detailed info
      response = await handleDebugPortfolioSync(request, env);
    } else if (path === '/debug/update-quantities' && request.method === 'POST') {
      // Debug endpoint to update existing trades with correct quantities from Tradier
      response = await handleDebugUpdateQuantities(request, env);
    } else if (path === '/debug/backfill-entry-prices' && request.method === 'POST') {
      // Debug endpoint to backfill entry_price for trades missing it
      response = await handleDebugBackfillEntryPrices(request, env);
    } else if (path === '/v2/debug/backfill-missing-trades' && request.method === 'POST') {
      // Debug endpoint to backfill missing trades for positions without matching trades
      response = await handleDebugBackfillMissingTrades(request, env);
    } else if (path === '/v2/debug/backfill-exit-prices' && (request.method === 'GET' || request.method === 'POST')) {
      // Debug endpoint to backfill missing exit prices for closed trades
      response = await handleDebugBackfillExitPrices(request, env, ctx);
    } else if (path === '/v2/debug/compare-tradier-closed' && request.method === 'GET') {
      // Debug endpoint to compare our closed trades with Tradier's gain/loss data
      response = await handleDebugCompareTradierClosed(request, env);
    } else if (path === '/v2/debug/analyze-trades-vs-tradier' && request.method === 'GET') {
      // Comprehensive analysis of D1 trades vs Tradier orders/positions
      response = await handleDebugAnalyzeTradesVsTradier(request, env);
    } else if (path === '/v2/debug/analyze-trades-detailed' && request.method === 'GET') {
      // Detailed D1 database analysis
      response = await handleDebugAnalyzeTradesDetailed(request, env);
    } else if (path === '/v2/debug/compare-portfolio-positions' && request.method === 'GET') {
      // Compare Tradier positions with portfolio_positions table
      response = await handleDebugComparePortfolioPositions(request, env);
    } else if (path === '/v2/debug/cleanup-stale-positions' && request.method === 'POST') {
      // Clean up stale portfolio positions (manual cleanup)
      response = await handleDebugCleanupStalePositions(request, env);
    } else if (path === '/v2/debug/force-portfolio-sync' && request.method === 'POST') {
      // Force a portfolio sync and show what was deleted
      response = await handleDebugForcePortfolioSync(request, env);
    } else if (path === '/v2/debug/trade-history' && request.method === 'GET') {
      // Debug endpoint to query trade history by symbol, status, date range
      response = await handleDebugTradeHistory(request, env);
    } else if (path === '/v2/debug/broker-events' && request.method === 'GET') {
      // Debug endpoint to query broker events by symbol, order_id, date range
      response = await handleDebugBrokerEvents(request, env);
    } else if (path === '/v2/debug/table-schema' && request.method === 'GET') {
      // Debug endpoint to query table schema from D1
      response = await handleDebugTableSchema(request, env);
    } else if (path === '/v2/debug/daily-recap' && request.method === 'GET') {
      // Debug endpoint to get today's trading activity recap
      response = await handleDebugDailyRecap(request, env, ctx);
    } else if (path === '/v2/debug/investigate-emergency-exits' && request.method === 'GET') {
      // Debug endpoint to investigate EMERGENCY exits and expired/cancelled orders
      response = await handleDebugInvestigateEmergencyExits(request, env, ctx);
    } else if (path === '/debug/migrate-tradier-first' && (request.method === 'POST' || request.method === 'GET')) {
      // One-time migration: realign D1 with Tradier positions - supports both GET and POST
      const { runTradierFirstMigration } = await import('./scripts/migrate-tradier-first');
      const migrationResult = await runTradierFirstMigration(env);
      response = new Response(
        JSON.stringify(migrationResult, null, 2),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } else {
      // 404 for unknown routes
      response = new Response(
        JSON.stringify({ error: 'Not found' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    
    // Add CORS headers to all responses
    return addCorsHeaders(response);
  },
  
  /**
   * Handle scheduled cron events
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const now = new Date();
    const cron = event.cron;
    
    // Route based on cron schedule
    // Per wrangler.toml:
    // - "0 13 * * MON-FRI"       → premarket (08:00 ET)
    // - "30-59 14 * * MON-FRI"   → trade cycle (09:30–09:59 ET)
    // - "*/1 15-20 * * MON-FRI"    → trade cycle (10:00–15:59 ET)
    // - "0 21 * * MON-FRI"         → trade cycle (16:00 ET final tick)
    // - "1-59/1 14-20 * * MON-FRI" → monitor cycle (every 1 min during RTH, offset)
    // - "*/1 14-21 * * MON-FRI"    → account snapshots (every 1 min during market hours)
    // - "0 14,17,20 * * MON-FRI"   → orphaned order cleanup (10:00, 13:00, 16:00 ET)
    
    if (cron === '0 13 * * MON-FRI') {
      // Premarket check
      await runPremarketCheck(env, now);
    } else if (cron === '*/1 14-21 * * MON-FRI') {
      // Account snapshot sync during market hours (every 1 minute)
      // Syncs positions, orders, and balances to keep all sync freshness timestamps updated
      await runAccountSync(env, now);
    } else if (
      cron === '30-59 14 * * MON-FRI' ||
      cron === '*/1 15-20 * * MON-FRI' ||
      cron === '0 21 * * MON-FRI'
    ) {
      // Trade cycle windows
      await runTradeCycle(env, now);
    } else if (cron === '1-59/1 14-20 * * MON-FRI') {
      // Monitor cycle
      console.log('[monitor] heartbeat', {
        source: 'CRON',
        now: now.toISOString(),
      });
      await runMonitorCycle(env, now);
    } else if (cron === '0 14 * * MON-FRI' || cron === '0 17 * * MON-FRI' || cron === '0 20 * * MON-FRI') {
      // Orphaned order cleanup (runs 3 times per day: 10:00, 13:00, 16:00 ET)
      await runOrphanedOrderCleanup(env, now);
    } else if (cron === '15 20 * * MON-FRI') {
      // Daily activity summary (runs at 4:15 PM ET)
      await runDailySummary(env, now);
    } else {
      // Unknown cron - log but don't fail
      console.warn(`Unknown cron schedule: ${cron}`);
    }
  },
};

