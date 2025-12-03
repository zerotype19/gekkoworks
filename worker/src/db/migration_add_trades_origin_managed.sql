-- Migration: Add origin and managed columns to trades table
-- Phase 1 of the portfolio separation refactor

-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- This migration should be run with error handling in application code
-- or via a script that checks for column existence first

-- Add origin column (default: 'ENGINE')
-- ALTER TABLE trades ADD COLUMN origin TEXT DEFAULT 'ENGINE';

-- Add managed column (default: 1, meaning managed=true)
-- ALTER TABLE trades ADD COLUMN managed INTEGER DEFAULT 1;

-- After running, update existing trades:
-- UPDATE trades SET origin = 'ENGINE' WHERE origin IS NULL;
-- UPDATE trades SET managed = 1 WHERE managed IS NULL;

