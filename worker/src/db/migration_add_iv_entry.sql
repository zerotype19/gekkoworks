-- Migration: Add iv_entry column to trades table
-- This stores the implied volatility at entry for IV crush exit logic

ALTER TABLE trades ADD COLUMN iv_entry REAL;

