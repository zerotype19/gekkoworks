# Daily Summary and Exit Fixes Summary

## Issues Fixed

### 1. Daily Summaries Showing 0 Data
**Problem**: Daily summaries were showing 0 for all metrics because date filtering was using UTC instead of ET dates.

**Fix**: 
- Updated `getTradesToday()` to filter trades by ET date in the application layer
- Fixed trade categorization in `generateDailySummaryData()` to use ET dates for `opened_at` and `closed_at`
- Ensures summaries correctly count trades that were opened/closed on the target ET date

### 2. Daily Summaries on Non-Trading Days
**Problem**: Summaries could be generated for weekends/holidays and showed in the list.

**Fix**:
- Added trading day check in POST endpoint - prevents generation for non-trading days
- Filter summary list to only show trading days
- Cron job already had trading day check, but manual generation needed the guard

### 3. BROKER_ALREADY_FLAT Auto-Closing Trades
**Problem**: Trades were being auto-closed as `BROKER_ALREADY_FLAT` when positions showed as flat in portfolio, even when Gekkoworks should be driving all closes.

**Fix**:
- **Monitor Cycle**: Changed logic to not auto-close trades when positions are flat
  - If positions are flat AND close order exists: Log and wait for order sync (expected)
  - If positions are flat BUT no close order: Log warning and leave trade OPEN for investigation (unexpected)
- **Exit Execution**: Updated `resolveExitQuantity()` to return different reasons:
  - `ALREADY_CLOSED_VIA_ORDER`: Positions flat with close order - wait for order sync
  - `POSITIONS_FLAT_NO_ORDER`: Positions flat without close order - needs investigation
  - `BROKER_ALREADY_FLAT`: Legacy case - still handled by `handleAlreadyFlat()` for backward compatibility
- Prevents premature auto-closing when positions appear flat but we haven't actually closed them yet

### 4. Missing Exit Prices and PnL
**Problem**: Closed trades were missing `exit_price` and `realized_pnl` even when they had `broker_order_id_close`.

**Fix**:
- Exit price backfill already exists in `orderSync.ts` (lines 643-689)
- The backfill logic handles:
  - Trades that are CLOSED but missing `exit_price`
  - Calculates `realized_pnl` from entry and exit prices
  - Only runs when close order is FILLED
- The new logic prevents auto-closing, allowing order sync to properly capture exit prices

### 5. Portfolio Sync Usage Verification
**Confirmed**: 
- Monitor cycle syncs portfolio positions BEFORE monitoring (line 48 in `monitorCycle.ts`)
- Exit execution uses `portfolio_positions` as source of truth via `getSpreadLegPositions()`
- Monitoring uses portfolio positions for bid/ask via `computeSpreadPositionSnapshot()`
- All exit decisions are now driven by portfolio sync data

## Code Changes

### Files Modified:
1. **`worker/src/db/queries.ts`**
   - Fixed `getTradesToday()` to use ET date filtering

2. **`worker/src/http/dailySummary.ts`**
   - Fixed trade categorization to use ET dates
   - Added trading day check for summary generation
   - Filter summary list to trading days only

3. **`worker/src/cron/monitorCycle.ts`**
   - Removed auto-close logic for flat positions
   - Added proper logging and investigation flags

4. **`worker/src/engine/exits.ts`**
   - Updated `resolveExitQuantity()` to distinguish between expected and unexpected flat positions
   - Added handlers for new return reasons
   - Improved logging for debugging

## Expected Behavior After Fixes

1. **Daily Summaries**: 
   - Only show trading days
   - Correctly count trades by ET date
   - Show accurate metrics for opened/closed trades

2. **Trade Exits**:
   - Trades won't be auto-closed unless we actually placed a close order
   - If positions appear flat without a close order, trade stays OPEN for investigation
   - Exit prices will be captured by order sync when close orders fill

3. **Portfolio-Driven Exits**:
   - All exit decisions use `portfolio_positions` as source of truth
   - Portfolio sync runs before monitoring
   - Exit execution uses portfolio positions for quantities

## Testing Recommendations

1. Verify daily summaries show correct data for recent trading days
2. Monitor logs for any `POSITIONS_FLAT_NO_ORDER` warnings - these indicate issues needing investigation
3. Verify exit prices are being captured for closed trades
4. Check that trades aren't being prematurely closed as BROKER_ALREADY_FLAT

