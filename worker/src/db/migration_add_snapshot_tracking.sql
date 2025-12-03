-- Migration: Add snapshot tracking for Tradier sync
-- This enables tracking which positions/orders were synced together in a single snapshot

-- 1. Create tradier_snapshots table to track sync operations
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

-- 2. Add snapshot_id to portfolio_positions (nullable for backward compatibility)
ALTER TABLE portfolio_positions ADD COLUMN snapshot_id TEXT;

CREATE INDEX IF NOT EXISTS idx_portfolio_positions_snapshot_id ON portfolio_positions(snapshot_id);

-- 3. Add snapshot_id to orders (nullable for backward compatibility)
ALTER TABLE orders ADD COLUMN snapshot_id TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_snapshot_id ON orders(snapshot_id);

-- 4. Create account_balances table to store balance snapshots
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

