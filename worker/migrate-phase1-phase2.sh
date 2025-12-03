#!/bin/bash
# Migration script for Phase 1 & Phase 2 changes
# Adds portfolio_positions table and origin/managed columns to trades

set -e

echo "Running Phase 1 & Phase 2 migrations..."

# Check if columns exist by trying to select them
# If they don't exist, add them
echo "Checking for origin and managed columns..."

# Try to add origin column (will fail if it exists, which is fine)
wrangler d1 execute gekkoworks_db --remote --command "ALTER TABLE trades ADD COLUMN origin TEXT DEFAULT 'ENGINE';" 2>/dev/null || echo "Column 'origin' may already exist, continuing..."

# Try to add managed column (will fail if it exists, which is fine)
wrangler d1 execute gekkoworks_db --remote --command "ALTER TABLE trades ADD COLUMN managed INTEGER DEFAULT 1;" 2>/dev/null || echo "Column 'managed' may already exist, continuing..."

# Run the SQL migration file (creates portfolio_positions table)
echo "Creating portfolio_positions table..."
wrangler d1 execute gekkoworks_db --remote --file=src/db/migration_phase1_phase2.sql

# Update existing trades with default values
echo "Updating existing trades with default values..."
wrangler d1 execute gekkoworks_db --remote --command "UPDATE trades SET origin = 'ENGINE' WHERE origin IS NULL;"
wrangler d1 execute gekkoworks_db --remote --command "UPDATE trades SET managed = 1 WHERE managed IS NULL;"

echo "Migration complete!"

