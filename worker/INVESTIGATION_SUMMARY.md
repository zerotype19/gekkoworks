# Investigation Summary: Three Critical Issues

## Issue 1: Monitoring Didn't Trigger Exits When In The Money

**Status:** Investigating

**Findings:**
- 1 open AAPL trade (290/295 call spread) with status OPEN
- Trade opened at 2025-12-03 15:59:38 UTC
- No exit orders found for this trade
- Need to check monitoring logs to see if profit targets were reached

**Next Steps:**
- Check monitoring logs for this trade ID: `abdd992a-efa8-43ae-9c1f-e9a25024dcf1`
- Verify profit target thresholds (should be 0.60 for debit spreads)
- Check if monitoring cycle is running and evaluating this trade

---

## Issue 2: Order Sync Not Updating Canceled Orders

**Status:** BUG FOUND - Order shows FILLED in Tradier but PLACED in database

**Findings:**
- Order `22223806` shows `FILLED` in Tradier but `PLACED` in our database
- Order sync should be updating this but isn't
- This is a critical bug - filled orders should be synced immediately

**Root Cause Analysis:**
1. Order sync uses `getAllOrders` with 2-day window
2. Matching by `client_order_id` first, then `tradier_order_id`
3. Status mapping should convert Tradier status to our format
4. **BUG:** Order sync might not be running frequently enough, or matching logic has issues

**Fix Required:**
- Ensure order sync runs every monitor cycle (already implemented)
- Verify `getAllOrders` includes filled/canceled orders
- Check if matching by `tradier_order_id` is working correctly
- Add immediate sync after order placement

---

## Issue 3: Proposals Invalidated Before Entry Attempt

**Status:** Investigating - 20 proposals invalidated recently

**Findings:**
- 20 AAPL proposals invalidated recently
- All are BULL_CALL_DEBIT strategy
- Scores range from 0.81 to 0.85 (good scores)
- Logs show proposals were generated but don't show invalidation reason

**Possible Reasons (from code analysis):**
1. **Proposal age > 15 minutes** - Most common reason
2. **Concentration limits** - MAX_SPREADS_PER_SYMBOL (default: 3)
3. **Price drift check failed** - Credit deteriorated below minimum
4. **Regime confidence too low** - Market choppy
5. **Validation failed** - Proposal status not READY
6. **Risk gates** - Daily limits or exposure caps

**Most Likely Cause:**
- **Concentration limits** - AAPL already has 3+ open spreads
- **Proposal age** - Proposal generated but entry attempted >15 minutes later

**Next Steps:**
- Check system logs for specific invalidation reasons
- Verify concentration limits for AAPL
- Check proposal creation vs entry attempt timing

---

## Recommendations

1. **Immediate Fix for Issue 2:**
   - Add explicit order status sync after order placement
   - Increase order sync frequency
   - Add logging when order status mismatch detected

2. **Monitoring Investigation:**
   - Add debug endpoint to check monitoring evaluation for specific trade
   - Verify profit target calculation
   - Check if monitoring is skipping trades

3. **Proposal Invalidation:**
   - Add explicit logging when proposals are invalidated
   - Show reason in UI
   - Consider extending proposal age limit if concentration is the issue

