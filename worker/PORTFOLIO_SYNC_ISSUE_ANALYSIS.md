# Portfolio Sync Issue Analysis

## Problem
- Tradier has **18 positions**
- Our DB has **20 positions** (2 extra)
- The 2 extra positions are stale and should be deleted:
  - AAPL 280 call (long) - quantity 1
  - AAPL 285 call (short) - quantity 1

## Root Cause

Looking at the portfolio sync logic in `portfolioSync.ts`:
1. It syncs all positions from Tradier into `positionKeys` array
2. It calls `deletePortfolioPositionsNotInSet(env, positionKeys)` to delete stale positions
3. The deletion query uses a `NOT EXISTS` subquery with `VALUES` clause

**The issue**: The `deletePortfolioPositionsNotInSet` function may not be working correctly if:
- The `positionKeys` array is built incorrectly
- The SQL query has a bug
- Portfolio sync isn't running frequently enough

## Expected Behavior
Portfolio sync should:
1. Fetch all positions from Tradier
2. Upsert them into `portfolio_positions`
3. Delete any positions in our DB that aren't in Tradier

## Fix
1. Verify `deletePortfolioPositionsNotInSet` is working correctly
2. Ensure portfolio sync runs frequently (it runs in monitorCycle and tradeCycle)
3. Add logging to track when positions are deleted
4. Create manual cleanup endpoint to force cleanup

## Portfolio Page
The portfolio page (`/portfolio`) should mirror Tradier exactly. Currently it's showing our DB data which includes the 2 stale positions.

**Solution**: The portfolio page already queries from `portfolio_positions` table, which should mirror Tradier. Once we fix the sync, the page will automatically show correct data.

