# Phase 3 Test Playbook - SANDBOX_PAPER Shakedown

## Pre-Test Verification

### 1. Portfolio Sync Check
- [ ] Run `/debug-portfolio-sync` endpoint
- [ ] Verify `portfolio_positions` matches Tradier:
  - [ ] All legs present with correct quantities
  - [ ] `cost_basis` populated (can be NULL)
  - [ ] `last_price` can be NULL (not used by engine)

### 2. Account Sync Check
- [ ] Verify `accountSync` runs successfully
- [ ] Check `account_snapshots` table has recent entries
- [ ] Confirm no errors in logs

---

## Test Execution: End-to-End Trade Flow

### Test Setup
- **Mode**: SANDBOX_PAPER
- **Trades to open**: 
  1. One small BULL_PUT_CREDIT spread
  2. One small BULL_CALL_DEBIT spread

---

## Checkpoint 1: Entry Flow (ENTRY_PENDING → OPEN)

### What to Verify

#### Trade Creation
- [ ] Trade created with:
  - `status='ENTRY_PENDING'`
  - `broker_order_id_open` set (Tradier order ID)
  - `origin='ENGINE'`
  - `managed=1`
  - `strategy` matches proposal exactly
  - `proposal_id` populated

#### After Fill
- [ ] `status='OPEN'`
- [ ] `entry_price` populated:
  - [ ] Non-null, > 0
  - [ ] Matches (roughly) net credit/debit in Tradier
  - [ ] For credit spread: positive (credit received)
  - [ ] For debit spread: positive (debit paid)
- [ ] `opened_at` set (ISO timestamp)
- [ ] `max_profit` and `max_loss` calculated correctly
- [ ] `iv_entry` populated (if available)

#### Portfolio Positions
- [ ] `portfolio_positions` updated:
  - [ ] Both legs present (short + long)
  - [ ] Quantities match trade quantity
  - [ ] `side` correct (short = 'short', long = 'long')
  - [ ] `cost_basis_per_contract` populated

---

## Checkpoint 2: Exit Order Structure (When Monitoring Fires)

### What to Inspect

#### System Logs: `[broker][placeSpreadOrder][debug]`

For **BULL_PUT_CREDIT** exit:
- [ ] `side: "EXIT"` (not "ENTRY")
- [ ] `orderType: "debit"` (flipped from credit)
- [ ] Both legs use `_to_close`:
  - [ ] Short leg: `side: "buy_to_close"`
  - [ ] Long leg: `side: "sell_to_close"`
- [ ] `quantity` matches:
  - [ ] `min(shortQty, longQty)` from `portfolio_positions`
  - [ ] Capped at `trade.quantity` (if applicable)
- [ ] `limit_price` present and > 0
- [ ] `class: "multileg"`

For **BULL_CALL_DEBIT** exit:
- [ ] `side: "EXIT"`
- [ ] `orderType: "credit"` (flipped from debit)
- [ ] Both legs use `_to_close`:
  - [ ] Long leg: `side: "sell_to_close"`
  - [ ] Short leg: `side: "buy_to_close"`
- [ ] `quantity` matches portfolio positions
- [ ] `limit_price` present and > 0

#### Trade Status
- [ ] `status='CLOSING_PENDING'`
- [ ] `broker_order_id_close` set
- [ ] `exit_reason` matches monitoring trigger:
  - [ ] `PROFIT_TARGET` (if profit target hit)
  - [ ] `STOP_LOSS` (if stop loss hit)
  - [ ] `TIME_EXIT` (if DTE threshold hit)
  - [ ] `EMERGENCY` (if emergency trigger)

---

## Checkpoint 3: Exit Fill (CLOSING_PENDING → CLOSED)

### What to Verify

#### Trade Closure
- [ ] `status='CLOSED'`
- [ ] `exit_reason` preserved from monitoring trigger
- [ ] `exit_price` populated:
  - [ ] Non-null, >= 0
  - [ ] Reasonable value (not 0 unless phantom close)
- [ ] `realized_pnl` populated:
  - [ ] Non-null (except for phantom closes)
  - [ ] Sign makes sense:
    - [ ] Credit spread: `entry_price - exit_price` (positive = profit)
    - [ ] Debit spread: `exit_price - entry_price` (positive = profit)
  - [ ] Magnitude reasonable vs entry/exit prices
- [ ] `closed_at` set (ISO timestamp)

#### PnL Calculation Log
- [ ] Check `[lifecycle][pnl]` log entry:
  - [ ] `strategy` matches trade
  - [ ] `entry_price` and `exit_price` shown
  - [ ] `realized_pnl` matches calculation
  - [ ] `is_debit_spread` flag correct
  - [ ] Calculation formula shown matches strategy type

#### Portfolio Positions
- [ ] `portfolio_positions` updated:
  - [ ] Both legs now have `quantity=0` (or reduced)
  - [ ] Positions removed if fully closed

---

## Checkpoint 4: Data Integrity

### Final Verification

#### All Trades
- [ ] Every trade has:
  - [ ] `proposal_id` populated
  - [ ] `strategy` populated
  - [ ] `broker_order_id_open` populated (for opened trades)
  - [ ] `entry_price` populated (for opened trades)
  - [ ] `exit_price` populated (for closed trades)
  - [ ] `realized_pnl` populated (for closed trades, except phantom closes)

#### Portfolio Consistency
- [ ] Run portfolio sync again
- [ ] Verify `portfolio_positions` matches Tradier exactly
- [ ] No orphaned positions (positions without matching trades)
- [ ] No orphaned trades (OPEN trades with no positions)

#### Account Snapshots
- [ ] Recent `account_snapshots` entries show:
  - [ ] `unrealized_pnl_open` updated
  - [ ] `realized_pnl_today` includes closed trades
  - [ ] `open_positions` count correct

---

## Success Criteria

✅ **PASS** if:
- All checkpoints pass
- Exit orders are correctly structured (sides, credit/debit, limits)
- Lifecycle transitions work correctly
- PnL calculations are correct (sign and magnitude)
- No fabricated PnL for phantom closes
- Portfolio positions match Tradier exactly

❌ **FAIL** if:
- Exit orders have wrong sides (`_to_open` instead of `_to_close`)
- Credit/debit not flipped on EXIT
- Quantities exceed actual positions
- PnL calculations are wrong (wrong sign or magnitude)
- Phantom closes fabricate PnL
- Portfolio positions don't match Tradier

---

## Quick Verification Commands

```bash
# Check portfolio positions
curl https://your-worker.workers.dev/debug-portfolio-sync

# Check recent system logs for exit orders
# Query system_logs table for entries containing "[broker][placeSpreadOrder][debug]"

# Check recent trades
# Query trades table for status='CLOSED' and verify exit_reason, exit_price, realized_pnl

# Check PnL logs
# Query system_logs for entries containing "[lifecycle][pnl]"
```

---

## Expected Log Patterns

### Successful Entry
```
[entry] order placed successfully
[entry] trade created with order ID
[orderSync] entry order filled, trade marked open
[lifecycle] lifecycle: {"trade_id":"...","from_status":"ENTRY_PENDING","to_status":"OPEN",...}
```

### Successful Exit
```
[monitor][exit-signal]
[exit][order][sent]
[broker][placeSpreadOrder][debug]: {"side":"EXIT","orderType":"debit",...}
[orderSync] exit order filled, trade marked closed
[lifecycle][pnl]: {"strategy":"BULL_PUT_CREDIT","entry_price":0.50,"exit_price":0.20,"realized_pnl":30.00,...}
[lifecycle] lifecycle: {"trade_id":"...","from_status":"CLOSING_PENDING","to_status":"CLOSED",...}
```

### Phantom Close
```
[monitor][phantom-close]
[lifecycle] lifecycle: {"trade_id":"...","exit_reason":"BROKER_ALREADY_FLAT","realized_pnl":null,...}
```

---

## Notes

- **Entry prices**: Always positive magnitudes (normalized from Tradier)
- **Exit prices**: Always positive magnitudes (normalized from Tradier)
- **PnL calculation**: 
  - Credit spreads: `entry_price - exit_price` (positive = profit)
  - Debit spreads: `exit_price - entry_price` (positive = profit)
- **Portfolio positions**: Source of truth for quantities, not prices
- **Live quotes**: Source of truth for current marks (monitoring triggers)

