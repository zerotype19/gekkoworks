# Tradier vs Gekkoworks Comparison - Dec 2, 2025

## Tradier Actual Activity (from orders.csv)

### Filled Close Orders on Dec 2:
- **1 filled close order**: Parent ID `22156068`
  - Leg 1: AAPL 280 call, sell_to_close, filled at $9.60
  - Leg 2: AAPL 285 call, buy_to_close, filled at $6.75
  - This is **1 spread trade** = **2 option contracts** in Tradier

### Gain/Loss Shows:
- 2 closed positions (the 2 legs of the 1 spread)
- Net result matches the spread close

### Entry Orders on Dec 2:
- 111 unique entry orders (all for AAPL call spreads 290/295)

## Gekkoworks Tracking

### Current Issue:
- Showing **5 closed trades** for Dec 2
- Tradier shows **1 closed spread** (2 positions)
- **Discrepancy: 4 extra trades**

## Root Cause Analysis

**We're tracking more closed trades than Tradier actually has!**

This means either:
1. We're closing trades that were never actually closed at Tradier
2. Date filtering is wrong - we're counting trades closed on different dates
3. We're marking trades as closed without actual close orders
4. We're tracking phantom/reconciliation trades incorrectly

## Required Fix

**CRITICAL**: Gekkoworks should only track trades that match Tradier exactly:
- Only 1 trade should show as closed on Dec 2 (parent order 22156068)
- That trade should map to the 2 option contracts in Tradier gain/loss
- Any trade without a matching Tradier close order is a phantom trade

## Action Items

1. **Audit all 5 closed trades** - check their broker_order_id_close values
2. **Verify date filtering** - ensure closed_at dates match Tradier close dates
3. **Remove phantom trades** - any trade closed without a Tradier order should be investigated
4. **Implement stricter validation** - never mark trade as closed unless close order exists AND is filled

## Expected State

After fix:
- **1 closed trade** on Dec 2
- Matches Tradier's 1 filled close order (22156068)
- Maps to 2 option contracts in Tradier gain/loss
- No phantom trades

