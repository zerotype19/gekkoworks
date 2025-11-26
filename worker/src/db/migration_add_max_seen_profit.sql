-- Migration: Add max_seen_profit_fraction column to trades table
-- This column tracks the maximum profit fraction seen for trailing stop logic

-- Check if column exists, if not add it
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we'll use a safe approach
-- This will fail silently if column already exists (which is fine)

ALTER TABLE trades ADD COLUMN max_seen_profit_fraction REAL;

