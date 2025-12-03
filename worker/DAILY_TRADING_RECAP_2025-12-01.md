# Daily Trading Activity Recap - December 1, 2025

**Analysis Time**: December 2, 2025 03:07 AM UTC  
**System Version**: `7f94362d-ff93-47d0-929d-472be4e7f5f7`  
**Trading Mode**: SANDBOX_PAPER  
**Date Range**: Trades opened/closed on December 1, 2025

---

## Executive Summary

⚠️ **System Functioning with Issues**
- ✅ Portfolio sync: Working correctly
- ✅ Order sync: Working correctly  
- ⚠️ **CRITICAL ISSUE**: 5 trades closed today with `exit_price = null` despite having `broker_order_id_close` set
- ⚠️ All 5 closed trades show `realized_pnl = null` (cannot calculate without exit_price)
- ✅ 1 trade successfully opened and remains open
- ❌ 142 error logs (mostly "no viable candidate" - normal when no trades pass filters)

---

## Trading Activity Today

### Trades Opened Today: **4**

1. **Trade ID**: `13b13227-897d-4ed5-a594-00c93fe2af11`
   - Symbol: AAPL
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.30
   - Status: **OPEN**
   - Opened At: 2025-12-01T15:15:19.641Z
   - Broker Order ID: `22107977`

2. **Trade ID**: `8397fe82-1cad-4af4-8320-3e30be0e60ad`
   - Symbol: SPY
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.43
   - Status: **CLOSED** (see below)
   - Opened At: 2025-12-01T15:02:19.639Z

3. **Trade ID**: `f6653d52-148c-42df-abc0-b221bd17ef8f`
   - Symbol: SPY
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.22
   - Status: **CLOSED** (see below)
   - Opened At: 2025-12-01T14:59:19.638Z

4. **Trade ID**: `3348a4ff-4abc-4f1c-9c9d-04ff8a103b11`
   - Symbol: SPY
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.31
   - Status: **CLOSED** (see below)
   - Opened At: 2025-12-01T14:56:19.640Z

### Trades Closed Today: **5**

**🚨 CRITICAL ISSUE: All 5 closed trades have `exit_price = null` and `realized_pnl = null`**

1. **Trade ID**: `8397fe82-1cad-4af4-8320-3e30be0e60ad`
   - Symbol: SPY
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.43
   - Exit Reason: **EMERGENCY**
   - Exit Price: **NULL** ⚠️
   - Realized PnL: **NULL** ⚠️
   - Broker Order ID Close: `22107708`
   - Closed At: 2025-12-01T15:14:19.639Z

2. **Trade ID**: `f6653d52-148c-42df-abc0-b221bd17ef8f`
   - Symbol: SPY
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.22
   - Exit Reason: **EMERGENCY**
   - Exit Price: **NULL** ⚠️
   - Realized PnL: **NULL** ⚠️
   - Broker Order ID Close: `22106142`
   - Closed At: 2025-12-01T15:01:19.639Z

3. **Trade ID**: `3348a4ff-4abc-4f1c-9c9d-04ff8a103b11`
   - Symbol: SPY
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.31
   - Exit Reason: **EMERGENCY**
   - Exit Price: **NULL** ⚠️
   - Realized PnL: **NULL** ⚠️
   - Broker Order ID Close: `22105740`
   - Closed At: 2025-12-01T14:59:19.640Z

4. **Trade ID**: `c6fd1c22-c4fe-4052-84f2-77507108f94a`
   - Symbol: SPY
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.25
   - Exit Reason: **STOP_LOSS**
   - Exit Price: **NULL** ⚠️
   - Realized PnL: **NULL** ⚠️
   - Broker Order ID Close: `22103696`
   - Closed At: 2025-12-01T14:45:18.494Z

5. **Trade ID**: `c8a0326e-c7ac-4d83-8fb2-a78a39547286`
   - Symbol: AAPL
   - Strategy: BULL_CALL_DEBIT
   - Entry Price: $2.314472368421052
   - Exit Reason: **EMERGENCY**
   - Exit Price: **NULL** ⚠️
   - Realized PnL: **NULL** ⚠️
   - Broker Order ID Close: `22104181`
   - Closed At: 2025-12-01T14:49:18.457Z

### Open Positions: **1**

- **Trade ID**: `13b13227-897d-4ed5-a594-00c93fe2af11`
  - Symbol: AAPL
  - Strategy: BULL_CALL_DEBIT
  - Entry Price: $2.30
  - Opened: 2025-12-01T15:15:19.641Z

---

## System Status

### System Health
- **System Mode**: NORMAL ✅
- **Risk State**: NORMAL ✅
- **Daily Realized PnL**: $0 (cannot calculate due to missing exit prices)
- **Emergency Exit Count Today**: 0
- **Open Positions**: 1
- **Portfolio Positions**: 6 (across 2 symbols)

### Portfolio Sync Status
- ✅ Working correctly
- 6 positions synced from Tradier
- Bid/ask prices stored in `portfolio_positions` table

### Order Sync Status
- ✅ Working correctly
- All trades have `broker_order_id_open` set
- All closed trades have `broker_order_id_close` set

---

## Critical Issues Found

### 🚨 Issue #1: Missing Exit Prices on Closed Trades

**Severity**: HIGH  
**Impact**: Cannot calculate realized PnL, cannot track performance

**Details**:
- 5 trades closed today with `broker_order_id_close` set (orders were placed)
- All 5 trades have `exit_price = null`
- All 5 trades have `realized_pnl = null`
- 4 trades closed with EMERGENCY exit reason
- 1 trade closed with STOP_LOSS exit reason

**Analysis**:
- Since `broker_order_id_close` is set, exit orders were successfully placed
- The issue appears to be that fill prices are not being captured when orders fill
- Possible causes:
  1. Orders filled but `pollCloseOrderUntilFilled` didn't capture the fill price
  2. Trades were closed via "already flat" path where positions didn't exist at broker
  3. Order sync hasn't run yet to backfill fill prices from Tradier

**Next Steps**:
1. Check if exit orders actually filled by querying Tradier for order details
2. Implement backfill logic to retrieve exit prices from Tradier order history
3. Add validation to ensure exit_price is always set when broker_order_id_close exists

### Issue #2: Multiple EMERGENCY Exits

**Severity**: MEDIUM  
**Impact**: Trades closing prematurely, possible system instability

**Details**:
- 4 trades closed with EMERGENCY exit reason
- EMERGENCY exits typically indicate:
  - Structural integrity issues (positions missing, strikes invalid)
  - Data corruption
  - System errors

**Analysis**:
- Need to review system logs to understand why EMERGENCY exits were triggered
- Possible causes:
  1. Positions not found in portfolio_positions (portfolio sync timing issue)
  2. Option chain data issues
  3. Structural integrity checks failing

---

## System Logs Analysis

### Errors Found: 142

Most errors are normal operational logs:
- `[tradeCycle] no viable candidate` - This is expected when no proposals pass the scoring threshold
- These are not actual errors, just informational logs tagged as errors

### Key Activity
- Trade cycles ran every minute during market hours (normal)
- Portfolio syncs running correctly
- Order syncs running correctly
- Monitoring cycles evaluating open trades correctly

---

## Verification of New Code

### ✅ Portfolio Sync: WORKING
- Bid/ask prices being fetched and stored
- Positions syncing correctly from Tradier
- 6 positions in portfolio_positions table

### ✅ Exit Price Capture: **NOT WORKING** ⚠️
- Exit orders being placed successfully
- Fill prices NOT being captured
- Need to investigate and fix

### ✅ Closing Details: **PARTIALLY WORKING** ⚠️
- `broker_order_id_close` being set correctly
- `exit_reason` being set correctly
- `exit_price` and `realized_pnl` NOT being set (critical issue)

---

## Recommendations

### Immediate Actions Required

1. **Fix Exit Price Capture** (HIGH PRIORITY)
   - Investigate why fill prices aren't being captured from exit orders
   - Implement backfill logic to retrieve exit prices from Tradier
   - Add validation to ensure exit_price is set when broker_order_id_close exists

2. **Investigate EMERGENCY Exits** (MEDIUM PRIORITY)
   - Review system logs to understand why 4 trades triggered EMERGENCY exits
   - Check if portfolio sync timing is causing position lookup failures
   - Verify structural integrity checks are working correctly

3. **Backfill Missing Exit Prices** (HIGH PRIORITY)
   - Create a script to query Tradier for order details using `broker_order_id_close`
   - Calculate exit_price from filled order leg prices
   - Update the 5 closed trades with correct exit_price and realized_pnl

### Code Review Needed

1. **`worker/src/engine/exits.ts`**
   - Review `pollCloseOrderUntilFilled` function
   - Ensure fill prices are being captured correctly
   - Check if "already flat" path is being used incorrectly

2. **`worker/src/engine/lifecycle.ts`**
   - Review `markTradeClosedWithReason` function
   - Ensure exit_price is always set when provided
   - Add validation to prevent null exit_price when broker_order_id_close exists

---

## Conclusion

The system is functioning correctly in most areas:
- ✅ Portfolio sync working
- ✅ Order sync working
- ✅ Trades opening successfully
- ✅ Exit orders being placed

However, there is a **critical issue** with exit price capture:
- ❌ Exit prices not being stored when trades close
- ❌ Realized PnL cannot be calculated
- ❌ Performance tracking is incomplete

**This needs immediate attention** as it prevents proper tracking of trading performance and PnL calculations.

