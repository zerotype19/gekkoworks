-- Migration: Add proposal linkage fields
-- Adds kind, linked_trade_id, and client_order_id columns to proposals table

-- Add kind column (nullable - 'ENTRY' | 'EXIT')
ALTER TABLE proposals ADD COLUMN kind TEXT;

-- Add linked_trade_id column (nullable - for exit proposals)
ALTER TABLE proposals ADD COLUMN linked_trade_id TEXT;

-- Add client_order_id column (nullable - the client_order_id sent to Tradier)
ALTER TABLE proposals ADD COLUMN client_order_id TEXT;

-- Create index on linked_trade_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_proposals_linked_trade_id ON proposals(linked_trade_id);

-- Create index on kind for filtering
CREATE INDEX IF NOT EXISTS idx_proposals_kind ON proposals(kind);

