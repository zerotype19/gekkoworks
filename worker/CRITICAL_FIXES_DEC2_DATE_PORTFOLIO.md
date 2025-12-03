# Critical Fixes for Dec 2: Date Filtering, Status Distinction, Portfolio Sync

## Issue 1: Date Filtering Bug ⚠️ CRITICAL

**Problem**: When querying for trades closed on Dec 2, we're getting trades closed on Dec 1.

**Root Cause**: 
- When creating a Date from "2025-12-02", JavaScript creates it as `2025-12-02T00:00:00.000Z` (midnight UTC)
- When converting to ET by subtracting 5 hours, it becomes `2025-12-01T19:00:00.000Z`
- This gives us date "2025-12-01" instead of "2025-12-02"!

**Fix**: 
- Added `parseETDateString()` function that parses YYYY-MM-DD date strings as ET dates
- Creates the date at noon ET (17:00 UTC) to avoid timezone boundary issues
- Use this function when parsing date parameters from URLs

**Files to Fix**:
- `worker/src/core/time.ts` - Added `parseETDateString()` function
- `worker/src/http/debugAnalyzeTradesVsTradier.ts` - Use `parseETDateString()` for date param
- `worker/src/http/debugAnalyzeTradesDetailed.ts` - Use `parseETDateString()` for date param
- `worker/src/http/dailySummary.ts` - Use `parseETDateString()` for date param

## Issue 2: Status Distinction (FILLED vs CLOSED)

**Problem**: Need to distinguish between:
- **FILLED** = Entry order filled (trade opened)
- **CLOSED** = Exit order filled (trade closed)

**Current State**: 
- Trade status can be OPEN, CLOSED, etc.
- But we need to track:
  - Entry order status (FILLED = trade opened)
  - Exit order status (FILLED = trade closed)

**Note**: This is already partially handled:
- `broker_order_id_open` with status FILLED = trade opened
- `broker_order_id_close` with status FILLED = trade closed

**Action**: Clarify in UI/documentation that:
- Trade FILLED = Entry order filled (trade opened)
- Trade CLOSED = Exit order filled (trade closed)

## Issue 3: Portfolio Positions Sync Mismatch

**Problem**: 18 positions in Tradier, but 20 in our `portfolio_positions` table.

**Possible Causes**:
1. Positions were closed at broker but not deleted from our DB
2. Duplicate positions in our DB
3. Positions that don't match Tradier's format (parseOptionSymbol returning null)

**Investigation Needed**:
- Check `deletePortfolioPositionsNotInSet()` logic
- Verify all positions in our DB match Tradier's format
- Check for duplicate entries

**Fix**: 
- Ensure `syncPortfolioFromTradier()` properly deletes positions not in Tradier
- Add logging to track sync discrepancies
- Add debug endpoint to compare Tradier positions vs portfolio_positions

