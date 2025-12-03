# Phase 2.1: Phantom Close & PnL Fixes

## ✅ Fixed Issues

### 1. Phantom Close PnL Calculation

**Problem:**
- `markTradeClosed` was being called with `exitPrice = 0` for `BROKER_ALREADY_FLAT` cases
- This would incorrectly calculate `realized_pnl`:
  - Credit spreads: Would show max profit (incorrect)
  - Debit spreads: Would show max loss (incorrect)
- We don't know the actual exit price or PnL for positions closed outside our system

**Solution:**
- Use `updateTrade` directly instead of `markTradeClosed`
- Set `realized_pnl: null` to indicate unknown PnL
- Set `exit_price: 0` as placeholder (or could be `null` if preferred)
- Still call `recordTradeClosed` to include in risk stats (with null PnL)

**Code Change:**
```typescript
// Before (incorrect):
const closed = await markTradeClosed(env, trade.id, 0, now, 'BROKER_ALREADY_FLAT');

// After (correct):
const updated = await updateTrade(env, trade.id, {
  status: 'CLOSED',
  exit_price: 0, // Placeholder - we don't know actual exit price
  closed_at: now.toISOString(),
  exit_reason: 'BROKER_ALREADY_FLAT',
  realized_pnl: null, // Important: don't invent PnL
});
await recordTradeClosed(env, updated);
```

### 2. Consistency: `recordTradeClosed` for Manual Closes

**Problem:**
- `MANUAL_CLOSE` cases were not calling `recordTradeClosed`
- Inconsistent with `BROKER_ALREADY_FLAT` handling

**Solution:**
- Added `recordTradeClosed` call for `MANUAL_CLOSE` cases
- Both `BROKER_ALREADY_FLAT` and `MANUAL_CLOSE` now:
  - Set `realized_pnl: null`
  - Call `recordTradeClosed` to include in risk history
  - Allow dashboards to see they ended (even without PnL)

### 3. Code Cleanup

**Removed:**
- Unused `parseOptionSymbol` import from `monitorCycle.ts`

**Updated:**
- Comment in `accountSync.ts` to reflect that exit logic uses `portfolio_positions` mirror, not direct Tradier calls

## 📝 Design Decision

**`realized_pnl: null` for Unknown Exits:**
- `BROKER_ALREADY_FLAT`: Position closed outside system, unknown exit price
- `MANUAL_CLOSE`: Position closed manually, unknown exit price
- Both are recorded in risk stats but with `null` PnL
- Dashboards can still show these trades ended, but won't show incorrect PnL

**Alternative Considered:**
- Could exclude these from risk stats entirely
- **Decision:** Include them with `null` PnL for better visibility and audit trail

## ✅ Validation

- ✅ TypeScript compilation passes
- ✅ All `recordTradeClosed` calls are consistent
- ✅ No synthetic PnL calculations for unknown exits
- ✅ Comments updated to reflect current architecture

