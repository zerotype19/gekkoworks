-- Migration: Phase 1 & Phase 2 - Portfolio Separation
-- Adds portfolio_positions table and origin/managed columns to trades

-- 1. Create portfolio_positions table
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
  updated_at TEXT NOT NULL              -- ISO timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_positions_key
  ON portfolio_positions (symbol, expiration, option_type, strike, side);

-- 2. Add origin column to trades (if it doesn't exist)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a workaround
-- Check if column exists by trying to select it - if it fails, add it
-- We'll handle this in application code, but document the intended change here

-- For manual execution, run these if columns don't exist:
-- ALTER TABLE trades ADD COLUMN origin TEXT DEFAULT 'ENGINE';
-- ALTER TABLE trades ADD COLUMN managed INTEGER DEFAULT 1;

-- 3. Update existing trades to have default values
-- These will be safe even if columns already exist (UPDATE with WHERE clause)
UPDATE trades SET origin = 'ENGINE' WHERE origin IS NULL;
UPDATE trades SET managed = 1 WHERE managed IS NULL;

