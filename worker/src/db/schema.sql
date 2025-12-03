-- SAS v1 Database Schema
-- Matches TradeRow, ProposalRow, SettingRow, RiskStateRow interfaces exactly

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  proposal_id TEXT,
  symbol TEXT NOT NULL,
  expiration TEXT NOT NULL,
  short_strike REAL NOT NULL,
  long_strike REAL NOT NULL,
  width REAL NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  entry_price REAL,
  exit_price REAL,
  max_profit REAL,
  max_loss REAL,
  status TEXT NOT NULL,
  exit_reason TEXT,
  broker_order_id_open TEXT,
  broker_order_id_close TEXT,
  opened_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  realized_pnl REAL,
  max_seen_profit_fraction REAL,
  iv_entry REAL,
  strategy TEXT DEFAULT 'BULL_PUT_CREDIT',
  origin TEXT DEFAULT 'ENGINE',
  managed INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  expiration TEXT NOT NULL,
  short_strike REAL NOT NULL,
  long_strike REAL NOT NULL,
  width REAL NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  strategy TEXT DEFAULT 'BULL_PUT_CREDIT',
  credit_target REAL NOT NULL,
  score REAL NOT NULL,
  ivr_score REAL NOT NULL,
  vertical_skew_score REAL NOT NULL,
  term_structure_score REAL NOT NULL,
  delta_fitness_score REAL NOT NULL,
  ev_score REAL NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT,
  linked_trade_id TEXT,
  client_order_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_strategy ON proposals(strategy);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_events (
  created_at TEXT NOT NULL,
  operation TEXT NOT NULL,
  symbol TEXT,
  expiration TEXT,
  order_id TEXT,
  status_code INTEGER,
  ok INTEGER NOT NULL,
  duration_ms INTEGER,
  mode TEXT NOT NULL,
  error_message TEXT,
  strategy TEXT,
  id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE INDEX IF NOT EXISTS idx_broker_events_created_at
  ON broker_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_broker_events_strategy 
  ON broker_events (strategy);

CREATE TABLE IF NOT EXISTS system_logs (
  created_at TEXT NOT NULL,
  log_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT,
  id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created_at
  ON system_logs (created_at DESC);

-- ============================================================================
-- Portfolio Positions
-- 
-- Pure mirror of Tradier positions (one row per leg, not per spread).
-- This is the source of truth for actual broker positions.
-- ============================================================================

CREATE TABLE IF NOT EXISTS portfolio_positions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  expiration TEXT NOT NULL,             -- 'YYYY-MM-DD'
  option_type TEXT NOT NULL,            -- 'call' or 'put'
  strike REAL NOT NULL,
  side TEXT NOT NULL,                   -- 'long' or 'short'
  quantity INTEGER NOT NULL,
  cost_basis_per_contract REAL,         -- nullable; per-contract basis
  last_price REAL,                      -- nullable; last/mark price
  bid REAL,                             -- nullable; current bid price (from option chain)
  ask REAL,                             -- nullable; current ask price (from option chain)
  snapshot_id TEXT,                     -- nullable; links to tradier_snapshots.id
  updated_at TEXT NOT NULL              -- ISO timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_positions_key
  ON portfolio_positions (symbol, expiration, option_type, strike, side);

-- ============================================================================
-- Account Snapshots
-- 
-- Per monitoring.md / architecture.md:
-- - Tradier is the source of truth for account-level balances/PnL
-- - We persist periodic snapshots so the dashboard can read a stable view
-- ============================================================================

CREATE TABLE IF NOT EXISTS account_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,              -- SANDBOX_PAPER, LIVE, etc.
  date TEXT NOT NULL,              -- 'YYYY-MM-DD' in ET
  captured_at TEXT NOT NULL,       -- ISO timestamp

  cash REAL,
  buying_power REAL,
  equity REAL,
  open_positions INTEGER,
  trades_closed_today INTEGER,
  realized_pnl_today REAL,
  realized_pnl_7d REAL,
  unrealized_pnl_open REAL,

  source TEXT NOT NULL DEFAULT 'TRADIER',  -- or 'INTERNAL'
  UNIQUE(account_id, mode, captured_at)
);

-- ============================================================================
-- Tradier Sync Snapshots
-- 
-- Tracks master sync operations to ensure all positions/orders/balances
-- are synced together in a coherent snapshot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tradier_snapshots (
  id TEXT PRIMARY KEY,                    -- snapshotId (UUID)
  account_id TEXT NOT NULL,
  as_of TEXT NOT NULL,                   -- ISO timestamp when snapshot was taken
  positions_count INTEGER DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  balances_cash REAL,
  balances_buying_power REAL,
  balances_equity REAL,
  balances_margin_requirement REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tradier_snapshots_as_of ON tradier_snapshots(as_of DESC);
CREATE INDEX IF NOT EXISTS idx_tradier_snapshots_account_id ON tradier_snapshots(account_id);

CREATE TABLE IF NOT EXISTS account_balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  cash REAL NOT NULL,
  buying_power REAL NOT NULL,
  equity REAL NOT NULL,
  margin_requirement REAL NOT NULL,
  as_of TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES tradier_snapshots(id)
);

CREATE INDEX IF NOT EXISTS idx_account_balances_snapshot_id ON account_balances(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_account_balances_as_of ON account_balances(as_of DESC);


