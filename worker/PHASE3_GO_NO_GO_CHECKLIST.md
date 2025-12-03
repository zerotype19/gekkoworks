# Phase 3 Go/No-Go Checklist

## Pre-Open Verification

### 1. Portfolio Sync Verification
- [ ] Run portfolio sync debug endpoint: `/debug-portfolio-sync`
- [ ] Verify `portfolio_positions` matches Tradier positions:
  - [ ] AAPL legs (280 call long 76, 285 call short 76)
  - [ ] SPY legs (686/687/688 long, 691/692/693 short)
  - [ ] Quantities match exactly
  - [ ] `cost_basis` populated (can be NULL, that's OK)
  - [ ] `last_price` can be NULL (not used by engine)

### 2. Monitor Cycle Dry Run
- [ ] Manually trigger monitor cycle
- [ ] Check logs for:
  - [ ] No fatal errors
  - [ ] Portfolio sync completed
  - [ ] Order sync completed
  - [ ] Phantom detection working (if any OPEN trades exist)

## During Open - End-to-End Trade Verification

### 3. Entry Flow (ENTRY_PENDING → OPEN)
- [ ] Trade created with:
  - [ ] `status='ENTRY_PENDING'`
  - [ ] `broker_order_id_open` set
  - [ ] `origin='ENGINE'`
  - [ ] `managed=1`
  - [ ] `strategy` matches proposal
- [ ] After fill:
  - [ ] `status='OPEN'`
  - [ ] `entry_price` populated (non-null, > 0)
  - [ ] `opened_at` set
  - [ ] `max_profit` and `max_loss` calculated correctly
  - [ ] `iv_entry` populated (if available)

### 4. Exit Order Structure (When Monitoring Fires)
Check `system_logs` for `[broker][placeSpreadOrder][debug]` entry:

- [ ] `side: "EXIT"` (not "ENTRY")
- [ ] `type` flipped correctly:
  - [ ] Credit spread exit → `type: "debit"`
  - [ ] Debit spread exit → `type: "credit"`
- [ ] Both legs use `_to_close`:
  - [ ] Short leg: `side: "buy_to_close"`
  - [ ] Long leg: `side: "sell_to_close"`
- [ ] `quantity` matches:
  - [ ] `min(shortQty, longQty)` from `portfolio_positions`
  - [ ] Capped at `trade.quantity` (if applicable)
- [ ] `limit_price` present and reasonable
- [ ] `class: "multileg"`

### 5. Exit Fill (CLOSING_PENDING → CLOSED)
- [ ] After fill:
  - [ ] `status='CLOSED'`
  - [ ] `exit_reason` matches monitoring trigger:
    - [ ] `PROFIT_TARGET` (if profit target hit)
    - [ ] `STOP_LOSS` (if stop loss hit)
    - [ ] `TIME_EXIT` (if DTE threshold hit)
    - [ ] `EMERGENCY` (if emergency trigger)
  - [ ] `exit_price` populated (non-null, >= 0)
  - [ ] `realized_pnl` populated (non-null, calculated correctly)
  - [ ] `closed_at` set

### 6. Phantom Close Verification (If Applicable)
- [ ] If trade manually closed in Tradier:
  - [ ] Monitor cycle detects `BROKER_ALREADY_FLAT`
  - [ ] `status='CLOSED'`
  - [ ] `exit_reason='BROKER_ALREADY_FLAT'`
  - [ ] `exit_price=null` (or 0, depending on implementation)
  - [ ] `realized_pnl=null` (no fabricated PnL)

## Post-Open Verification

### 7. Data Integrity
- [ ] All trades have:
  - [ ] `proposal_id` populated
  - [ ] `strategy` populated
  - [ ] `broker_order_id_open` populated (for opened trades)
  - [ ] `entry_price` populated (for opened trades)
  - [ ] `exit_price` populated (for closed trades)
  - [ ] `realized_pnl` populated (for closed trades, except phantom closes)

### 8. Portfolio Consistency
- [ ] Run portfolio sync again
- [ ] Verify `portfolio_positions` still matches Tradier
- [ ] No orphaned positions (positions without matching trades)
- [ ] No orphaned trades (OPEN trades with no positions)

## Success Criteria

✅ **GO** if:
- All checklist items pass
- Exit orders are correctly structured (sides, credit/debit, limits)
- Lifecycle transitions work correctly
- No fabricated PnL for phantom closes
- Portfolio positions match Tradier exactly

❌ **NO-GO** if:
- Exit orders have wrong sides (`_to_open` instead of `_to_close`)
- Credit/debit not flipped on EXIT
- Quantities exceed actual positions
- Phantom closes fabricate PnL
- Portfolio positions don't match Tradier

## Quick Verification Commands

```bash
# Check portfolio positions
curl https://your-worker.workers.dev/debug-portfolio-sync

# Check recent system logs for exit orders
# (Query system_logs table for entries containing "[broker][placeSpreadOrder][debug]")

# Check recent trades
# (Query trades table for status='CLOSED' and verify exit_reason, exit_price, realized_pnl)
```

