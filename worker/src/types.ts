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
  | 'MANUAL_CLOSE'
  | 'PHANTOM_TRADE'
  | 'NORMAL_EXIT';

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
  // Origin: 'ENGINE' | 'IMPORTED' | 'MANUAL'
  origin?: string;
  // Managed: 1 = engine can auto-monitor/exit, 0 = engine must ignore
  managed?: number;
}

export type ProposalStatus = 'READY' | 'INVALIDATED' | 'CONSUMED';

export type ProposalKind = 'ENTRY' | 'EXIT';

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
  
  // New fields for explicit linkage
  kind?: ProposalKind | null;   // 'ENTRY' | 'EXIT'
  linked_trade_id?: string | null;  // nullable - for exit proposals
  client_order_id?: string | null;  // nullable - the client_order_id we sent to Tradier
}

export type OrderStatus = 'PENDING' | 'PLACED' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export type OrderSide = 'ENTRY' | 'EXIT';

export interface OrderRow {
  id: string;                   // UUID
  proposal_id: string;          // NOT NULL - every order is linked to a proposal
  trade_id: string | null;      // nullable - populated once trade exists
  client_order_id: string;      // UNIQUE - the ID we send to Tradier
  tradier_order_id: string | null;  // Tradier's order ID (from their response)
  side: OrderSide;              // 'ENTRY' | 'EXIT'
  status: OrderStatus;          // 'PENDING' | 'PLACED' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED'
  avg_fill_price: number | null;
  filled_quantity: number;
  remaining_quantity: number;
  snapshot_id: string | null;   // Links to tradier_snapshots.id
  created_at: string;           // ISO datetime
  updated_at: string;           // ISO datetime
}

export interface SettingRow {
  key: string;
  value: string;
}

// ============================================================================
// Portfolio Positions (Pure mirror of Tradier positions)
// ============================================================================

export interface PortfolioPositionRow {
  id: string;                          // UUID
  symbol: string;                      // Option symbol (e.g., 'SPY251212P00645000')
  expiration: string;                  // 'YYYY-MM-DD'
  option_type: 'call' | 'put';
  strike: number;
  side: 'long' | 'short';
  quantity: number;                    // Always >= 0 (absolute value)
  cost_basis_per_contract: number | null;
  last_price: number | null;
  bid: number | null;                  // Current bid price (from option chain, updated during portfolio sync)
  ask: number | null;                  // Current ask price (from option chain, updated during portfolio sync)
  snapshot_id: string | null;           // Links to tradier_snapshots.id
  updated_at: string;                  // ISO timestamp
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

export interface DailySummaryRow {
  date: string;              // YYYY-MM-DD in ET
  generated_at: string;       // ISO timestamp
  summary_data: string;       // JSON string of the summary
  created_at: string;         // ISO timestamp
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
  client_order_id?: string | null;  // Optional - Tradier may return this if we sent it
  tag?: string | null;              // Optional - Tradier may return the tag we sent
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
  client_order_id?: string;  // Optional: client order ID for tracking
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

  // Pricing
  short_bid: number;
  short_ask: number;
  long_bid: number;
  long_ask: number;

  // Greeks
  short_delta: number | null;
  long_delta: number | null;
  short_iv: number | null;
  long_iv: number | null;

  // Computed
  credit: number;              // short_bid - long_ask
  debit: number;               // long_bid - short_ask
  mid_price: number;           // (credit + debit) / 2
  max_profit: number;          // credit (for credit spreads)
  max_loss: number;            // width - credit (for credit spreads)
}

export interface CandidateScoring {
  ivr_score: number;            // 0-1
  vertical_skew_score: number;  // 0-1
  term_structure_score: number; // 0-1
  delta_fitness_score: number; // 0-1
  ev_score: number;            // 0-1
  composite_score: number;     // weighted average
}

export interface ProposalCandidate {
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  quantity: number;
  strategy: string;
  credit_target: number;
  metrics: CandidateMetrics;
  scoring: CandidateScoring;
}

// ============================================================================
// Risk & System State
// ============================================================================

export interface RiskSnapshot {
  system_mode: 'NORMAL' | 'HARD_STOP' | 'COOLDOWN';
  risk_state: string;
  daily_realized_pnl: number;
  emergency_exit_count_today: number;
}

// ============================================================================
// Monitoring & Exit Decision
// ============================================================================

export type ExitTriggerType =
  | 'NONE'
  | 'PROFIT_TARGET'
  | 'STOP_LOSS'
  | 'TIME_EXIT'
  | 'IV_CRUSH_EXIT'
  | 'TRAIL_PROFIT'
  | 'LOW_VALUE_CLOSE'
  | 'EMERGENCY'
  | 'STRUCTURAL_BREAK';

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

export interface MonitoringDecision {
  trigger: ExitTriggerType;
  metrics: MonitoringMetrics;
}

export interface EntryAttemptResult {
  trade: TradeRow | null;
  reason: string;
}

export interface ExitExecutionResult {
  success: boolean;
  reason?: string;  // Optional - some exits may not have a specific reason
  fillPrice?: number;
  trade?: TradeRow;  // Optional - the updated trade after exit
  trigger?: ExitTriggerType;  // Optional - the exit trigger that was used
}
