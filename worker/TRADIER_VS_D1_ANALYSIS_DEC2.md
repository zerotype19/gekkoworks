# Tradier vs D1 Database Analysis - Dec 2, 2025

## Critical Findings

### Issue 1: Date Filtering Bug
**Problem**: Trades closed on Dec 1 are being counted as closed on Dec 2

**Evidence**:
- Our system shows 5 closed trades for Dec 2
- ALL 5 trades have `closed_at` = "2025-12-01" (Dec 1)
- Date filtering is incorrectly converting UTC dates to ET dates

**Example**:
- Trade closed_at: "2025-12-01T15:14:19.639Z" (Dec 1, 3:14 PM ET)
- Being counted as: Dec 2 (wrong!)

### Issue 2: Phantom Closes
**Problem**: Trades marked as CLOSED but close orders are NOT FOUND in Tradier

**Evidence**:
- 5 trades have `broker_order_id_close` set
- But when querying Tradier for those order IDs, they're not found (or on wrong date)
- Orders exist but they're from Dec 1, not Dec 2

**Close Order IDs in our system**:
- 22107708 (SPY) - EXPIRED on Dec 1, not FILLED
- 22106142 (SPY) - CANCELED on Dec 1, not FILLED  
- 22105740 (SPY) - FILLED on Dec 1
- 22104181 (AAPL) - FILLED on Dec 1
- 22103696 (SPY) - FILLED on Dec 1

**Actual Dec 2 close order**:
- 22156068 (AAPL) - FILLED on Dec 2 - THIS IS THE ONLY REAL CLOSE!

### Issue 3: Missing Exit Prices
**Problem**: 2 of the 5 closed trades are missing `exit_price` and `realized_pnl`

**Trades with missing data**:
- Trade 8397fe82... (SPY, EMERGENCY) - no exit_price, no PnL
- Trade f6653d52... (SPY, EMERGENCY) - no exit_price, no PnL

### Issue 4: Order Status Mismatch
**Problem**: Trades marked as CLOSED but the close orders were EXPIRED or CANCELED, not FILLED

**Examples**:
- Order 22107708: Status = EXPIRED (not FILLED) but trade marked as CLOSED
- Order 22106142: Status = CANCELED (not FILLED) but trade marked as CLOSED

## Root Causes

1. **Date Filtering**: UTC to ET conversion is wrong, causing Dec 1 closes to show as Dec 2
2. **Phantom Closes**: System marking trades as CLOSED when orders are EXPIRED/CANCELED, not FILLED
3. **No Order Validation**: Not checking if close order actually FILLED before marking trade as CLOSED
4. **Exit Price Backfill**: Not working for trades closed with EXPIRED/CANCELED orders

## Expected State

**For Dec 2, 2025:**
- Should show: **1 closed trade** (matching Tradier order 22156068)
- Should NOT show: Any trades closed on Dec 1
- All closed trades MUST have:
  - `broker_order_id_close` that exists in Tradier
  - Close order status = FILLED
  - `exit_price` populated
  - `realized_pnl` calculated

## Action Items

1. Fix date filtering to properly handle UTC to ET conversion
2. Only mark trade as CLOSED if close order status is FILLED
3. Handle EXPIRED/CANCELED close orders differently (don't mark as CLOSED)
4. Fix exit price backfill to work for all close order statuses
5. Ensure we only track trades that match Tradier exactly

