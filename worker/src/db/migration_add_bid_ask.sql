-- Migration: Add bid/ask columns to portfolio_positions
-- This allows portfolio sync to store current bid/ask prices, reducing API calls during monitoring

-- Add bid column (nullable - will be populated during portfolio sync)
ALTER TABLE portfolio_positions ADD COLUMN bid REAL;

-- Add ask column (nullable - will be populated during portfolio sync)
ALTER TABLE portfolio_positions ADD COLUMN ask REAL;

