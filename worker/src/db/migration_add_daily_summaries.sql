-- Migration: Add daily_summaries table
-- Stores daily trading activity summaries generated at end of trading day

CREATE TABLE IF NOT EXISTS daily_summaries (
  date TEXT PRIMARY KEY,  -- Format: YYYY-MM-DD (ET date)
  generated_at TEXT NOT NULL,  -- ISO timestamp when summary was generated
  summary_data TEXT NOT NULL,  -- JSON string containing all summary data
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_summaries_date 
  ON daily_summaries (date DESC);

