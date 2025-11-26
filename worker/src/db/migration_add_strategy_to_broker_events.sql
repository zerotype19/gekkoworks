-- Migration: Add strategy column to broker_events table
-- This allows the debug endpoint to show which strategy was used for each order

ALTER TABLE broker_events ADD COLUMN strategy TEXT;

-- Create index for faster queries by strategy
CREATE INDEX IF NOT EXISTS idx_broker_events_strategy 
  ON broker_events (strategy);

