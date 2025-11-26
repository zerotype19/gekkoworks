/**
 * Type definitions for API responses
 */

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  timestamp: string;
}

export interface StatusResponse {
  system_mode: 'NORMAL' | 'HARD_STOP';
  risk_state: string;
  daily_realized_pnl: number;
  emergency_exit_count_today: number;
  open_positions: number;
  trading_mode: 'DRY_RUN' | 'SANDBOX_PAPER' | 'LIVE';
  market_hours: boolean;
  trading_day: boolean;
  timestamp: string;
}

export interface RiskSnapshot {
  system_mode: 'NORMAL' | 'HARD_STOP';
  risk_state: string;
  daily_realized_pnl: number;
  emergency_exit_count_today: number;
}

export interface SystemModeHistoryEntry {
  from: 'NORMAL' | 'HARD_STOP' | string;
  to: 'NORMAL' | 'HARD_STOP' | string;
  reason: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface SystemModeInfo {
  system_mode: 'NORMAL' | 'HARD_STOP';
  risk_state: string;
  emergency_exit_count_today: number;
  trading_mode: 'DRY_RUN' | 'SANDBOX_PAPER' | 'LIVE' | string;
  last_hard_stop_at: string | null;
  last_hard_stop_reason: string | null;
  last_mode_change: string | null;
  history: SystemModeHistoryEntry[];
  timestamp: string;
}

export interface SystemModeUpdateResponse {
  success: boolean;
  system_mode: 'NORMAL' | 'HARD_STOP';
  reason: string;
  timestamp: string;
}

export interface Trade {
  id: string;
  proposal_id: string | null;
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  entry_price: number | null;
  exit_price: number | null;
  max_profit: number | null;
  max_loss: number | null;
  status: string;
  exit_reason: string | null;
  broker_order_id_open: string | null;
  broker_order_id_close: string | null;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  realized_pnl: number | null;
}

export interface TradesResponse {
  trades: Trade[];
  count: number;
}

