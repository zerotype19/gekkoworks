/**
 * API client for Gekkoworks Worker
 * Primarily read-only, with a few debug/test POST helpers.
 */

import type {
  HealthResponse,
  StatusResponse,
  RiskSnapshot,
  TradesResponse,
  Trade,
  SystemModeInfo,
  SystemModeUpdateResponse,
} from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://gekkoworks-api.kevin-mcgovern.workers.dev';

async function fetchApi<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`);
  
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json() as Promise<T>;
}

export async function getHealth(): Promise<HealthResponse> {
  return fetchApi<HealthResponse>('/health');
}

export async function getStatus(): Promise<StatusResponse> {
  return fetchApi<StatusResponse>('/status');
}

export type MarketStatus =
  | 'OPEN'
  | 'CLOSED_PREMARKET'
  | 'CLOSED_POSTMARKET'
  | 'CLOSED_WEEKEND'
  | 'CLOSED';

export interface DashboardSummary {
  mode: string;
  trading_mode: 'DRY_RUN' | 'SANDBOX_PAPER' | 'LIVE' | string;
  market_hours: boolean;
  market_status: MarketStatus;
  trading_day: boolean;

  cash: number;
  buying_power: number;
  equity: number;

  realized_pnl_today: number;
  unrealized_pnl_open: number;
  open_positions: number;
  open_spreads: number;
  trades_closed_today: number;

  last_updated: string | null;
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  return fetchApi<DashboardSummary>('/dashboard/summary');
}

export async function getTrades(): Promise<TradesResponse> {
  return fetchApi<TradesResponse>('/trades');
}

export async function getTrade(id: string): Promise<Trade> {
  return fetchApi<Trade>(`/trades/${id}`);
}

export async function getRiskSnapshot(): Promise<RiskSnapshot> {
  return fetchApi<RiskSnapshot>('/risk-state');
}

export async function getSystemModeInfo(): Promise<SystemModeInfo> {
  return fetchApi<SystemModeInfo>('/debug/system-mode');
}

export async function updateSystemMode(
  mode: 'NORMAL' | 'HARD_STOP',
  reason = mode === 'NORMAL' ? 'MANUAL_RESET_FROM_UI' : 'MANUAL_HARD_STOP_FROM_UI'
): Promise<SystemModeUpdateResponse> {
  const res = await fetch(`${API_BASE_URL}/debug/system-mode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode, reason }),
  });

  if (!res.ok) {
    const message = await res.text();
    throw new Error(
      `Failed to update system mode: ${res.status} ${res.statusText}${message ? ` - ${message}` : ''}`
    );
  }

  return res.json() as Promise<SystemModeUpdateResponse>;
}

export interface TestProposalResponse {
  success: boolean;
  connectivity?: {
    success: boolean;
    error: string;
  };
  proposal?: unknown;
  candidate?: {
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    credit: number;
    score: number;
  } | null;
  timestamp?: string;
  error?: string;
}

export async function runTestProposal(): Promise<TestProposalResponse> {
  const res = await fetch(`${API_BASE_URL}/test/proposal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<TestProposalResponse>;
}

export interface BrokerEvent {
  id: number;
  created_at: string;
  operation: string;
  symbol: string | null;
  expiration: string | null;
  order_id: string | null;
  status_code: number | null;
  ok: boolean;
  duration_ms: number | null;
  mode: string;
  error_message: string | null;
}

export interface SystemLog {
  id: number;
  created_at: string;
  log_type: string;
  message: string;
  details: string | null;
}

export interface BrokerEventsResponse {
  events: BrokerEvent[];
  systemLogs: SystemLog[];
}

export async function getBrokerEvents(limit = 100): Promise<BrokerEventsResponse> {
  const res = await fetch(`${API_BASE_URL}/broker-events?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch broker events: ${res.status}`);
  }
  const data = await res.json();
  return {
    events: data.events as BrokerEvent[],
    systemLogs: data.systemLogs as SystemLog[],
  };
}

export interface ProposalWithOrders {
  proposal: {
    id: string;
    symbol: string;
    expiration: string;
    short_strike: number;
    long_strike: number;
    width: number;
    quantity: number;
    strategy: string;
    credit_target: number;
    score: number;
    status: string;
    created_at: string;
    ivr_score: number;
    vertical_skew_score: number;
    term_structure_score: number;
    delta_fitness_score: number;
    ev_score: number;
    min_score_required: number;
    min_credit_required: number;
  };
  trade: {
    id: string;
    status: string;
    entry_price: number | null;
    exit_price: number | null;
    opened_at: string | null;
    closed_at: string | null;
    broker_order_id_open: string | null;
    broker_order_id_close: string | null;
  } | null;
  outcome: 'PENDING' | 'FILLED' | 'REJECTED' | 'INVALIDATED' | 'NOT_ATTEMPTED';
  outcomeReason: string;
  rejectionReasons: string[];
  entryOrder: {
    order_id: string | null;
    status_code: number | null;
    ok: boolean;
    error_message: string | null;
    created_at: string;
    duration_ms: number | null;
  } | null;
  entryOrderStatus: {
    order_id: string | null;
    status_code: number | null;
    ok: boolean;
    error_message: string | null;
    created_at: string;
  } | null;
  exitOrder: {
    order_id: string | null;
    status_code: number | null;
    ok: boolean;
    error_message: string | null;
    created_at: string;
  } | null;
  entryLogs: Array<{
    created_at: string;
    message: string;
    details: string | null;
  }>;
  exitLogs: Array<{
    created_at: string;
    message: string;
    details: string | null;
  }>;
}

export interface ProposalsAndOrdersResponse {
  timestamp: string;
  proposals: ProposalWithOrders[];
  summary: {
    total: number;
    filled: number;
    rejected: number;
    pending: number;
    invalidated: number;
    not_attempted: number;
  };
}

export async function getProposalsAndOrders(limit = 50): Promise<ProposalsAndOrdersResponse> {
  return fetchApi<ProposalsAndOrdersResponse>(`/v2/proposals-and-orders?limit=${limit}`);
}

export interface DbHealthResponse {
  timestamp: string;
  checks: {
    quote_spy?: { ok: boolean; [key: string]: any };
    trades_by_status?: { ok: boolean; [key: string]: any };
    open_trades?: { ok: boolean; [key: string]: any };
    settings?: { ok: boolean; [key: string]: any };
  };
}

export async function getDbHealth(): Promise<DbHealthResponse> {
  return fetchApi<DbHealthResponse>('/debug/health/db');
}

export interface ResetRiskStateResponse {
  success: boolean;
  message: string;
  before: {
    system_mode: string;
    risk_state: string;
    daily_realized_pnl: number;
    emergency_exit_count_today: number;
  };
  after: {
    system_mode: string;
    risk_state: string;
    daily_realized_pnl: number;
    emergency_exit_count_today: number;
  };
  timestamp: string;
}

export async function resetRiskState(): Promise<ResetRiskStateResponse> {
  const res = await fetch(`${API_BASE_URL}/test/reset-risk-state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<ResetRiskStateResponse>;
}

export interface SystemSettings {
  timestamp: string;
  settings: {
    trading: Record<string, string>;
    scoring: Record<string, string>;
    risk: Record<string, string>;
    exitRules: Record<string, string>;
    other: Record<string, string>;
  };
  all: Record<string, string>;
}

export async function getSystemSettings(): Promise<SystemSettings> {
  return fetchApi<SystemSettings>('/v2/admin/settings');
}

export interface UpdateSettingRequest {
  key: string;
  value: string;
}

export interface UpdateSettingResponse {
  timestamp: string;
  key: string;
  value: string | null;
  success: boolean;
}

export async function updateSystemSetting(
  key: string,
  value: string
): Promise<UpdateSettingResponse> {
  const res = await fetch(`${API_BASE_URL}/v2/admin/settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key, value }),
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<UpdateSettingResponse>;
}

