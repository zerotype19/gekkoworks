/**
 * SAS v1 Type Definitions
 * 
 * All types and interfaces from system-interfaces.md
 * These are the canonical contracts for the entire system.
 */

import type { Env } from './env';
import type { TradingMode } from './core/config';

// ============================================================================
// Database Row Types
// ============================================================================

export type TradeStatus =
  | 'ENTRY_PENDING'
  | 'OPEN'
  | 'CLOSING_PENDING'
  | 'CLOSED'
  | 'CANCELLED'
  | 'CLOSE_FAILED'
  | 'INVALID_STRUCTURE'
  | 'EXIT_ERROR';

export type ExitReason =
  | 'PROFIT_TARGET'
  | 'STOP_LOSS'
  | 'TIME_EXIT'
  | 'EMERGENCY'
  | 'UNKNOWN'
  | 'BROKER_ALREADY_FLAT'
  | 'QUANTITY_MISMATCH'
  | 'MAX_EXIT_ATTEMPTS'
  | 'MANUAL_CLOSE';

export interface TradeRow {
  id: string;                  // UUID
  proposal_id: string | null;

  symbol: string;              // 'SPY'
  expiration: string;          // ISO date 'YYYY-MM-DD'
  short_strike: number;
  long_strike: number;
  width: number;               // 5 in v1
  quantity: number;            // number of contracts (default 1, but can be 2, 3, 4, etc.)
  strategy?: string;           // 'BULL_PUT_CREDIT' | 'BEAR_CALL_CREDIT' | 'BULL_CALL_DEBIT' | 'BEAR_PUT_DEBIT' | 'IRON_CONDOR'

  entry_price: number | null;  // credit received
  exit_price: number | null;   // debit paid to close
  max_profit: number | null;
  max_loss: number | null;

  status: TradeStatus;
  exit_reason: ExitReason | null;

  broker_order_id_open: string | null;
  broker_order_id_close: string | null;

  opened_at: string | null;    // ISO datetime
  closed_at: string | null;    // ISO datetime
  created_at: string;          // ISO datetime (trade record creation)
  updated_at: string;          // ISO datetime (last update)

  realized_pnl: number | null;
  // Tracking best seen profit as a fraction of max_profit to power trailing exits
  max_seen_profit_fraction?: number | null;
  // Implied volatility at entry (for IV crush exit logic)
  iv_entry?: number | null;
}

export type ProposalStatus = 'READY' | 'INVALIDATED' | 'CONSUMED';

export interface ProposalRow {
  id: string;                   // UUID
  symbol: string;               // 'SPY'
  expiration: string;           // ISO date
  short_strike: number;
  long_strike: number;
  width: number;
  quantity: number;             // number of contracts (configurable, default 1)
  strategy?: string;            // 'BULL_PUT_CREDIT' | 'BEAR_CALL_CREDIT' | 'BULL_CALL_DEBIT' | 'BEAR_PUT_DEBIT' | 'IRON_CONDOR'

  credit_target: number;        // target entry credit
  score: number;                // composite score (0–1)

  ivr_score: number;
  vertical_skew_score: number;
  term_structure_score: number;
  delta_fitness_score: number;
  ev_score: number;

  created_at: string;           // ISO datetime
  status: ProposalStatus;
}

export interface SettingRow {
  key: string;
  value: string;
}

export interface RiskStateRow {
  key: string;
  value: string;
}

export interface BrokerEventRow {
  id: number;
  created_at: string;
  operation: string;
  symbol: string | null;
  expiration: string | null;
  order_id: string | null;
  status_code: number | null;
  ok: boolean;
  duration_ms: number | null;
  mode: TradingMode;
  strategy: string | null;
  error_message: string | null;
}

export interface SystemLogRow {
  id: number;
  created_at: string;
  log_type: string;
  message: string;
  details: string | null;
}

export interface AccountSnapshotRow {
  id: number;
  account_id: string;
  mode: string;
  date: string;
  captured_at: string;

  cash: number | null;
  buying_power: number | null;
  equity: number | null;
  open_positions: number | null;
  trades_closed_today: number | null;
  realized_pnl_today: number | null;
  realized_pnl_7d: number | null;
  unrealized_pnl_open: number | null;

  source: string;
}

// ============================================================================
// Broker Layer Interfaces
// ============================================================================

export interface UnderlyingQuote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  change: number | null;
  change_percentage: number | null;
  prev_close: number | null;
}

export type OptionType = 'call' | 'put';

export interface OptionQuote {
  symbol: string;              // OCC option symbol
  underlying: string;          // 'SPY'
  type: OptionType;
  expiration_date: string;     // ISO date
  strike: number;

  bid: number;
  ask: number;
  last: number | null;

  delta: number | null;
  implied_volatility: number | null;
}

export type BrokerOrderStatus =
  | 'NEW'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export interface BrokerOrder {
  id: string;                      // Tradier order id
  status: BrokerOrderStatus;
  avg_fill_price: number | null;   // per-spread or per-unit basis
  filled_quantity: number;
  remaining_quantity: number;
  created_at: string | null;
  updated_at: string | null;
}

export type SpreadSide = 'ENTRY' | 'EXIT';

export interface SpreadLeg {
  option_symbol: string;
  side: 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';
  quantity: number;  // always 1 in v1
}

export interface PlaceSpreadOrderParams {
  symbol: string;           // 'SPY'
  side: SpreadSide;         // ENTRY or EXIT
  limit_price?: number;      // Optional: required for limit orders, omitted for market orders
  legs: [SpreadLeg, SpreadLeg];  // exactly 2 legs
  tag: string;              // 'GEKKOWORKS-ENTRY' or 'GEKKOWORKS-EXIT'
  strategy?: string;        // Optional: 'BULL_PUT_CREDIT' | 'BULL_CALL_DEBIT' | etc. - used to determine order type
  order_type?: 'limit' | 'market';  // Optional: 'limit' (default) or 'market' for forced closes
}

export interface BrokerPosition {
  symbol: string;
  quantity: number;
  cost_basis: number | null;
  market_value?: number | null;
  gain_loss?: number | null;
  // Additional fields as needed for reconciliation, not core logic.
}

export interface BrokerClient {
  getUnderlyingQuote(symbol: string): Promise<UnderlyingQuote>;

  getOptionChain(
    symbol: string,
    expiration: string
  ): Promise<OptionQuote[]>;

  placeSpreadOrder(params: PlaceSpreadOrderParams): Promise<BrokerOrder>;

  getOrder(orderId: string): Promise<BrokerOrder>;

  getPositions(): Promise<BrokerPosition[]>;

  getAllOrders(filter?: 'all' | 'intraday', startDate?: string, endDate?: string): Promise<BrokerOrder[]>;
}

// ============================================================================
// Core Metrics & Scoring Interfaces
// ============================================================================

export interface CandidateMetrics {
  symbol: string;
  expiration: string;

  short_strike: number;
  long_strike: number;
  width: number;

  credit: number;

  ivr: number;
  rv_30d: number;
  iv_30d: number;

  // Vertical skew between short and long leg IVs (long_iv - short_iv, 0–1 range)
  vertical_skew: number;
  // Alias / convenience field for vertical skew (same value as vertical_skew)
  verticalSkew: number;

  // Per-leg liquidity as percentage bid/ask spreads (e.g. 0.01 = 1%)
  short_pct_spread: number;
  long_spread?: number;
  long_pct_spread: number;
  term_structure: number;

  delta_short: number;
  delta_long?: number; // Optional: delta of long leg (used for debit spreads)

  // EV inputs:
  pop: number;
  max_profit: number;
  max_loss: number;
}

export interface ScoringResult {
  ivr_score: number;                // 0–1
  vertical_skew_score: number;      // 0–1
  term_structure_score: number;     // 0–1
  delta_fitness_score: number;      // 0–1
  ev_score: number;                 // 0–1

  composite_score: number;          // 0–1

  ev: number;                       // raw expected value
  pop: number;                      // 0–1
}

// ============================================================================
// Risk Management Interfaces
// ============================================================================

export type SystemMode = 'NORMAL' | 'HARD_STOP';

export type RiskStateFlag =
  | 'NORMAL'
  | 'DAILY_STOP_HIT'
  | 'PREMARKET_CHECK_FAILED'
  | 'BROKER_RATE_LIMITED'
  | 'EMERGENCY_EXIT_OCCURRED_TODAY';

export interface RiskSnapshot {
  system_mode: SystemMode;
  risk_state: RiskStateFlag;
  daily_realized_pnl: number;
  emergency_exit_count_today: number;
}

// ============================================================================
// Engine Interfaces
// ============================================================================

export interface ProposalCandidate {
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  credit: number;
  strategy: 'BULL_PUT_CREDIT' | 'BEAR_CALL_CREDIT' | 'BULL_CALL_DEBIT' | 'BEAR_PUT_DEBIT' | 'IRON_CONDOR';

  metrics: CandidateMetrics;
  scoring: ScoringResult;
}

export interface ProposalResult {
  proposal: ProposalRow | null;  // persisted
  candidate: ProposalCandidate | null;
}

export interface EntryAttemptResult {
  trade: TradeRow | null;
  reason?: string; // for logging if no trade
}

export interface LiveLegQuotes {
  short_bid: number;
  short_ask: number;
  long_bid: number;
  long_ask: number;
  delta_short: number;
  iv_short: number;
  iv_long: number;
}

export interface MonitoringMetrics {
  current_mark: number;
  unrealized_pnl: number;
  pnl_fraction: number;
  loss_fraction: number;
  dte: number;

  underlying_price: number;
  underlying_change_1m: number;
  underlying_change_15s: number;

  liquidity_ok: boolean;
  quote_integrity_ok: boolean;
}

export type ExitTriggerType =
  | 'NONE'
  | 'EMERGENCY'
  | 'STOP_LOSS'
  | 'PROFIT_TARGET'
  | 'TRAIL_PROFIT'
  | 'TIME_EXIT'
  | 'IV_CRUSH_EXIT'
  | 'LOW_VALUE_CLOSE';

export interface MonitoringDecision {
  trigger: ExitTriggerType;
  metrics: MonitoringMetrics;
}

export interface ExitExecutionResult {
  trade: TradeRow;
  trigger: ExitTriggerType;
  success: boolean;
  reason?: string;
}

