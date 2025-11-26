-- Add quantity column to proposals table
ALTER TABLE proposals ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;

