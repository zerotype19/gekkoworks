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
  iv_entry REAL
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
  status TEXT NOT NULL
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


