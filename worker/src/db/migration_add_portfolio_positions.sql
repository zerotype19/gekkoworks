-- Migration: Add portfolio_positions table and origin/managed columns to trades
-- Phase 1 of the portfolio separation refactor

-- Add portfolio_positions table
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

-- Add origin and managed columns to trades (if they don't exist)
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- So we'll need to handle this in application code or use a try-catch pattern
-- For now, we'll add them with a default value

-- In application code, check if column exists before adding
-- This migration file documents the intended schema change

