-- Migration: Add quantity column to trades table
-- Default to 1 for existing trades, then we'll update them from Tradier positions

ALTER TABLE trades ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;

