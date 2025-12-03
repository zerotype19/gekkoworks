# Trade Quantity Fix Summary

**Date:** 2025-12-03  
**Status:** ✅ **FIXED AND DEPLOYED**

## Issue

Trade record showed `quantity: 1` but portfolio positions showed `quantity: 67`. This mismatch could cause confusion in reporting, even though exits were already using portfolio positions correctly.

## Root Cause

The trade was created with `quantity: 1`, but 67 contracts were actually filled. The trade quantity was never updated to match the actual portfolio position.

## Solution

### 1. Immediate Fix
- Created `/debug/sync-trade-quantities` endpoint to manually sync trade quantities
- Fixed the AAPL trade: updated from `quantity: 1` to `quantity: 67`
- Also updated `max_profit` and `max_loss` proportionally

### 2. Automatic Sync
- Added `syncTradeQuantitiesFromPortfolio()` function to `monitorCycle.ts`
- Runs automatically after portfolio sync (every 1 minute during market hours)
- Keeps `trade.quantity` in sync with actual portfolio positions
- Updates `max_profit` and `max_loss` proportionally when quantity changes

### 3. Exit Quantity Verification
- Enhanced logging in `executeExitForTrade()` to explicitly show:
  - `trade.quantity` (for reference only)
  - `short_qty_to_close` and `long_qty_to_close` (from Tradier positions - source of truth)
  - Portfolio quantities for comparison
- Added comment: "CRITICAL: These quantities come from Tradier positions (source of truth), NOT from trade.quantity"

## Architecture Confirmation

**Exits ALREADY use portfolio quantities correctly:**
1. `computeAvailableQuantities()` reads from `portfolio_positions` via `getSpreadLegPositions()`
2. `executeExitForTrade()` uses `actualShortAvailable` and `actualLongAvailable` from Tradier positions
3. Exit orders use `shortQtyToClose` and `longQtyToClose` from portfolio positions, NOT `trade.quantity`

**The fix ensures:**
- `trade.quantity` stays in sync with portfolio positions (for reporting consistency)
- Exits continue to use portfolio positions as source of truth (unchanged behavior)
- Automatic sync prevents future mismatches

## Code Changes

### New Files
- `worker/src/http/debugSyncTradeQuantities.ts` - Manual sync endpoint

### Modified Files
- `worker/src/cron/monitorCycle.ts` - Added automatic quantity sync
- `worker/src/engine/exits.ts` - Enhanced logging to show quantity sources
- `worker/src/index.ts` - Added route for debug endpoint

## Testing

✅ **Verified:**
- Trade quantity updated from 1 to 67
- Portfolio positions show 67 contracts
- Monitoring can find positions correctly
- Exits will use 67 contracts (from portfolio), not 1 (from trade.quantity)

## Endpoints

- `/debug/sync-trade-quantities?dry_run=true` - Check for quantity mismatches (dry run)
- `/debug/sync-trade-quantities?dry_run=false` - Fix quantity mismatches
- `/debug/test-monitoring-with-portfolio` - Verify monitoring can find portfolio positions

## Conclusion

✅ **Trade quantity mismatch fixed**
✅ **Automatic sync added to prevent future mismatches**
✅ **Exits confirmed to use portfolio quantities (source of truth)**

The system now:
1. Automatically syncs trade quantities from portfolio positions every monitor cycle
2. Uses portfolio positions as source of truth for exit orders (unchanged)
3. Keeps trade.quantity accurate for reporting consistency

