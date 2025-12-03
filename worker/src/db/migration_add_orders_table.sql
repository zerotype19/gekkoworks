-- Migration: Add orders table and update proposals/trades for explicit linkage
-- This implements proposal → order → trade linkage with client_order_id

-- 1. Create orders table
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  trade_id TEXT,                    -- nullable - populated once trade exists
  client_order_id TEXT UNIQUE NOT NULL,  -- the ID we send to Tradier
  tradier_order_id TEXT,            -- Tradier's order ID (from their response)
  side TEXT NOT NULL,                -- 'ENTRY' | 'EXIT'
  status TEXT NOT NULL,              -- 'PENDING' | 'PLACED' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED'
  avg_fill_price REAL,               -- nullable
  filled_quantity INTEGER DEFAULT 0,
  remaining_quantity INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id),
  FOREIGN KEY (trade_id) REFERENCES trades(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_proposal_id ON orders(proposal_id);
CREATE INDEX IF NOT EXISTS idx_orders_trade_id ON orders(trade_id);
CREATE INDEX IF NOT EXISTS idx_orders_client_order_id ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_tradier_order_id ON orders(tradier_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 2. Add new columns to proposals table
ALTER TABLE proposals ADD COLUMN kind TEXT;  -- 'ENTRY' | 'EXIT'
ALTER TABLE proposals ADD COLUMN linked_trade_id TEXT;  -- nullable - for exit proposals
ALTER TABLE proposals ADD COLUMN client_order_id TEXT;  -- nullable - the client_order_id we sent to Tradier

CREATE INDEX IF NOT EXISTS idx_proposals_kind ON proposals(kind);
CREATE INDEX IF NOT EXISTS idx_proposals_linked_trade_id ON proposals(linked_trade_id);
CREATE INDEX IF NOT EXISTS idx_proposals_client_order_id ON proposals(client_order_id);

-- Note: We keep broker_order_id_open and broker_order_id_close on trades for backward compatibility
-- but going forward, orders table is the source of truth

