import { useEffect, useState, useCallback } from 'react';
import {
  getDashboardSummary,
  getTrades,
  runTestProposal,
  getSystemModeInfo,
  updateSystemMode,
  resetRiskState,
} from '../api';
import type { SystemModeInfo, TradesResponse } from '../types';

export default function Dashboard() {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof getDashboardSummary>> | null>(null);
  const [trades, setTrades] = useState<TradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposalRunning, setProposalRunning] = useState(false);
  const [proposalMessage, setProposalMessage] = useState<string | null>(null);
  const [showDebugTools, setShowDebugTools] = useState(false);
  const [systemModeInfo, setSystemModeInfo] = useState<SystemModeInfo | null>(null);
  const [systemModeLoading, setSystemModeLoading] = useState(false);
  const [systemModeError, setSystemModeError] = useState<string | null>(null);
  const [systemModeAction, setSystemModeAction] = useState<'idle' | 'reset' | 'stop'>('idle');
  const [riskStateResetting, setRiskStateResetting] = useState(false);

  const loadSystemModeInfo = useCallback(async () => {
    try {
      setSystemModeLoading(true);
      const info = await getSystemModeInfo();
      setSystemModeInfo(info);
      setSystemModeError(null);
    } catch (err) {
      setSystemModeError(err instanceof Error ? err.message : 'Failed to load system mode');
    } finally {
      setSystemModeLoading(false);
    }
  }, []);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [summaryData, tradesData] = await Promise.all([
          getDashboardSummary(),
          getTrades(),
        ]);
        setSummary(summaryData);
        setTrades(tradesData);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (showDebugTools) {
      loadSystemModeInfo();
    }
  }, [showDebugTools, loadSystemModeInfo]);

  const handleSystemModeUpdate = async (mode: 'NORMAL' | 'HARD_STOP') => {
    try {
      setSystemModeAction(mode === 'NORMAL' ? 'reset' : 'stop');
      await updateSystemMode(mode);
      await loadSystemModeInfo();
      setSystemModeError(null);
    } catch (err) {
      setSystemModeError(err instanceof Error ? err.message : 'Failed to update system mode');
    } finally {
      setSystemModeAction('idle');
    }
  };

  const handleResetRiskState = async () => {
    try {
      setRiskStateResetting(true);
      setSystemModeError(null);
      await resetRiskState();
      await loadSystemModeInfo();
      setSystemModeError(null);
    } catch (err) {
      setSystemModeError(err instanceof Error ? err.message : 'Failed to reset risk state');
    } finally {
      setRiskStateResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-600">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-600">Error: {error}</div>
      </div>
    );
  }

  const openTrades =
    trades?.trades.filter(t =>
      t.status === 'OPEN' ||
      t.status === 'ENTRY_PENDING' ||
      t.status === 'CLOSING_PENDING'
    ) || [];

  const openSnapshot = openTrades.slice(0, 3);

  const tradingModeColor = {
    DRY_RUN: 'bg-yellow-100 text-yellow-800',
    SANDBOX_PAPER: 'bg-blue-100 text-blue-800',
    LIVE: 'bg-green-100 text-green-800',
  }[summary?.trading_mode || 'DRY_RUN'];

  const closedToday = summary?.trades_closed_today ?? 0;
  const marketStatus = summary?.market_status || 'CLOSED';
  const marketStatusLabelMap: Record<string, string> = {
    OPEN: 'Open',
    CLOSED_PREMARKET: 'Closed (Pre-Market)',
    CLOSED_POSTMARKET: 'Closed (Post-Market)',
    CLOSED_WEEKEND: 'Closed (Weekend)',
    CLOSED: 'Closed',
  };
  const marketStatusColorMap: Record<string, string> = {
    OPEN: 'text-green-600',
    CLOSED_PREMARKET: 'text-gray-600',
    CLOSED_POSTMARKET: 'text-gray-600',
    CLOSED_WEEKEND: 'text-gray-600',
    CLOSED: 'text-gray-600',
  };
  const marketStatusLabel = marketStatusLabelMap[marketStatus] || 'Closed';
  const marketStatusColor = marketStatusColorMap[marketStatus] || 'text-gray-600';

  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'https://gekkoworks-api.kevin-mcgovern.workers.dev';

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <button
            onClick={() => setShowDebugTools(!showDebugTools)}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            {showDebugTools ? '▼ Hide' : '▶ Show'} Debug Tools
          </button>
        </div>
        
        {/* Key Metrics - Compact Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 mb-6">
          {/* Trading Mode */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Mode</h2>
            <div className={`inline-block px-2 py-1 rounded-full text-xs font-semibold ${tradingModeColor}`}>
              {summary?.trading_mode || 'DRY_RUN'}
            </div>
          </div>

          {/* Market Status */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Market</h2>
            <div className={`text-lg font-semibold ${marketStatusColor}`}>
              {marketStatusLabel}
            </div>
          </div>

          {/* Daily PnL */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Daily PnL</h2>
            <div className={`text-xl font-bold ${(summary?.realized_pnl_today || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              ${(summary?.realized_pnl_today || 0).toFixed(2)}
            </div>
          </div>

          {/* Open Spreads */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Open Spreads</h2>
            <div className="text-xl font-bold text-gray-900">
              {summary?.open_spreads ?? 0}
            </div>
          </div>

          {/* Open Legs */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Open Legs (Tradier)</h2>
            <div className="text-xl font-bold text-gray-900">
              {summary?.open_positions || 0}
            </div>
          </div>

          {/* Unrealized PnL */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Unrealized</h2>
            <div className={`text-xl font-bold ${(summary?.unrealized_pnl_open || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              ${(summary?.unrealized_pnl_open || 0).toFixed(2)}
            </div>
          </div>

          {/* Trades Closed Today */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Closed Today</h2>
            <div className="text-xl font-bold text-gray-900">
              {closedToday}
            </div>
          </div>

          {/* Total Trades */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-xs font-medium text-gray-500 mb-1">Total</h2>
            <div className="text-xl font-bold text-gray-900">
              {trades?.count || 0}
            </div>
          </div>
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

          {/* Manual Proposal Generation */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-sm font-medium text-gray-500 mb-2">Manual Proposal</h2>
            <p className="text-sm text-gray-500 mb-4">
              Trigger a one-off proposal generation using the same engine the cron uses.
            </p>
            <button
              type="button"
              onClick={async () => {
                try {
                  setProposalRunning(true);
                  setProposalMessage(null);
                  const res = await runTestProposal();
                  if (res.success && res.candidate) {
                    setProposalMessage(
                      `OK: ${res.candidate.symbol} ${res.candidate.expiration} ` +
                      `${res.candidate.short_strike}/${res.candidate.long_strike} ` +
                      `credit ${res.candidate.credit.toFixed(2)} score ${res.candidate.score.toFixed(3)}`
                    );
                  } else if (res.success) {
                    setProposalMessage('OK: proposal engine ran but no candidate was selected.');
                  } else {
                    setProposalMessage(`Error: ${res.error || 'proposal generation failed'}`);
                  }
                } catch (e) {
                  setProposalMessage(
                    e instanceof Error ? e.message : 'Failed to run manual proposal'
                  );
                } finally {
                  setProposalRunning(false);
                }
              }}
              disabled={proposalRunning}
              className={`inline-flex items-center px-4 py-2 rounded-md text-sm font-semibold text-white ${
                proposalRunning ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              {proposalRunning ? 'Running…' : 'Run Proposal Now'}
            </button>
            {proposalMessage && (
              <div className="mt-3 text-xs text-gray-600 break-words">
                {proposalMessage}
              </div>
            )}
          </div>

          {/* Debug Tools - Collapsible */}
          {showDebugTools && (
            <>
              {/* System Status & Health */}
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-sm font-medium text-gray-500 mb-3">System Status & Health</h2>
                <div className="space-y-1.5">
                  <a href={`${apiBaseUrl}/status`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">📊 System Status</a>
                  <a href={`${apiBaseUrl}/v2/debug/health`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">🔍 System Health (v2)</a>
                  <a href={`${apiBaseUrl}/debug/health/db`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">🗄️ DB Health</a>
                  <a href={`${apiBaseUrl}/v2/debug/auto-config`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">⚙️ Auto Mode Config</a>
                  <a href={`${apiBaseUrl}/v2/debug/auto-readiness`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">✅ Auto Mode Readiness</a>
                  <a href={`${apiBaseUrl}/risk-state`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">⚠️ Risk State</a>
                  <a href={`${apiBaseUrl}/debug/exit-rules`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">🎯 Exit Rules Config</a>
                </div>
              </div>

              {/* System Mode Control */}
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-sm font-medium text-gray-500 mb-3">System Mode Control</h2>
                {systemModeLoading && (
                  <div className="text-xs text-gray-500">Loading system mode…</div>
                )}
                {!systemModeLoading && systemModeInfo && (
                  <div className="space-y-1 text-sm text-gray-700 mb-4">
                    <div>
                      <span className="font-semibold">Mode:</span>{' '}
                      <span className={systemModeInfo.system_mode === 'NORMAL' ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                        {systemModeInfo.system_mode}
                      </span>
                    </div>
                    <div>
                      <span className="font-semibold">Risk State:</span>{' '}
                      <span className={systemModeInfo.risk_state === 'NORMAL' ? 'text-green-600 font-semibold' : 'text-amber-600 font-semibold'}>
                        {systemModeInfo.risk_state}
                      </span>
                    </div>
                    <div>
                      <span className="font-semibold">Emergency Exits Today:</span> {systemModeInfo.emergency_exit_count_today}
                    </div>
                    {systemModeInfo.last_hard_stop_reason && (
                      <div className="text-xs text-gray-500">
                        Last hard stop reason: {systemModeInfo.last_hard_stop_reason}
                      </div>
                    )}
                    {systemModeInfo.last_mode_change && (
                      <div className="text-xs text-gray-500">
                        Last mode change: {new Date(systemModeInfo.last_mode_change).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}
                {systemModeError && (
                  <div className="text-xs text-red-600 mb-2">
                    {systemModeError}
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    type="button"
                    onClick={() => handleSystemModeUpdate('NORMAL')}
                    disabled={systemModeAction !== 'idle'}
                    className={`inline-flex justify-center items-center px-3 py-2 rounded-md text-sm font-semibold text-white ${
                      systemModeAction !== 'idle'
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-emerald-600 hover:bg-emerald-700'
                    }`}
                  >
                    {systemModeAction === 'reset' ? 'Resetting…' : 'Reset System Mode'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSystemModeUpdate('HARD_STOP')}
                    disabled={systemModeAction !== 'idle'}
                    className={`inline-flex justify-center items-center px-3 py-2 rounded-md text-sm font-semibold text-white ${
                      systemModeAction !== 'idle'
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-red-600 hover:bg-red-700'
                    }`}
                  >
                    {systemModeAction === 'stop' ? 'Applying…' : 'Trigger HARD_STOP'}
                  </button>
                  {systemModeInfo && systemModeInfo.risk_state !== 'NORMAL' && (
                    <button
                      type="button"
                      onClick={handleResetRiskState}
                      disabled={riskStateResetting || systemModeAction !== 'idle'}
                      className={`inline-flex justify-center items-center px-3 py-2 rounded-md text-sm font-semibold text-white ${
                        riskStateResetting || systemModeAction !== 'idle'
                          ? 'bg-gray-400 cursor-not-allowed'
                          : 'bg-amber-600 hover:bg-amber-700'
                      }`}
                    >
                      {riskStateResetting ? 'Resetting…' : 'Reset Risk State'}
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-gray-500">
                  System mode uses `/debug/system-mode`. Risk state reset uses `/test/reset-risk-state`. Disabled automatically in LIVE trading.
                </p>
              </div>

              {/* Manual Operations */}
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-sm font-medium text-gray-500 mb-3">Manual Operations</h2>
                <div className="space-y-1.5">
                  <a href={`${apiBaseUrl}/debug/monitor`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">🔄 Run Monitor Cycle</a>
                  <a href={`${apiBaseUrl}/debug/system-mode`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">🔧 System Mode</a>
                  <a href={`${apiBaseUrl}/broker-events`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">📡 Broker Events</a>
                </div>
              </div>

              {/* Tradier-First Tools */}
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-sm font-medium text-gray-500 mb-3">Tradier-First Tools</h2>
                <div className="space-y-1.5">
                  <a href={`${apiBaseUrl}/v2/admin/reconcile?autoRepair=false`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">🔍 Reconcile (Check)</a>
                  <a href={`${apiBaseUrl}/v2/admin/reconcile?autoRepair=true`} target="_blank" rel="noopener noreferrer" className="block text-xs text-orange-600 hover:text-orange-800 hover:underline">🛠️ Reconcile (Auto-Repair)</a>
                  <a href={`${apiBaseUrl}/debug/portfolio-sync`} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-600 hover:text-indigo-800 hover:underline">📊 Portfolio Sync</a>
                  <a href={`${apiBaseUrl}/debug/migrate-tradier-first`} target="_blank" rel="noopener noreferrer" className="block text-xs text-red-600 hover:text-red-800 hover:underline">🔄 Migrate (One-Time)</a>
                </div>
              </div>
            </>
          )}

          {/* Open Positions Snapshot */}
          <div className="bg-white rounded-lg shadow p-6 md:col-span-2 lg:col-span-3">
            <h2 className="text-sm font-medium text-gray-500 mb-2">Open Positions Snapshot</h2>
            {openTrades.length === 0 ? (
              <div className="text-sm text-gray-500">No open or pending positions.</div>
            ) : (
              <div className="space-y-1 text-sm text-gray-900">
                {openSnapshot.map(trade => (
                  <div key={trade.id} className="flex items-center justify-between py-1">
                    <div>
                      <span className="font-mono mr-2">{trade.symbol}</span>
                      <span className="text-gray-500 mr-2">{trade.expiration}</span>
                      <span className="font-mono">{trade.short_strike}/{trade.long_strike}</span>
                    </div>
                    <div className="text-xs text-gray-500 uppercase">{trade.status}</div>
                  </div>
                ))}
                {openTrades.length > openSnapshot.length && (
                  <div className="text-xs text-gray-400 mt-1">
                    + {openTrades.length - openSnapshot.length} more open positions
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Last Updated */}
        {summary?.last_updated && (
          <div className="mt-6 text-sm text-gray-500 text-center">
            Last updated: {new Date(summary.last_updated).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
}

