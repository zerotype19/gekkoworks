-- Migration: Add strategy field to proposals and trades tables
-- This enables multi-strategy support (BULL_PUT_CREDIT, BEAR_CALL_CREDIT, IRON_CONDOR)

ALTER TABLE proposals ADD COLUMN strategy TEXT DEFAULT 'BULL_PUT_CREDIT';
ALTER TABLE trades ADD COLUMN strategy TEXT DEFAULT 'BULL_PUT_CREDIT';

-- Create index for strategy lookups
CREATE INDEX IF NOT EXISTS idx_proposals_strategy ON proposals(strategy);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);

