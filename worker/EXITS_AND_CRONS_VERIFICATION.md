# Exits and Cron Jobs - Core Fields Protection Verification

## Summary

Verified that `exits.ts` and all entry/exit cron jobs (`tradeCycle.ts`, `monitorCycle.ts`) do NOT overwrite core fields and only populate appropriate information in the trades D1 table.

## Protected Core Fields (Never Overwritten)

These fields are protected by `updateTrade` and cannot be overwritten:
- `proposal_id`
- `symbol`
- `expiration`
- `short_strike`
- `long_strike`
- `width`
- `strategy` (with exception for data integrity fixes)

## Exits.ts Verification

### ✅ All `updateTrade` Calls Reviewed

**Location:** `worker/src/engine/exits.ts`

#### 1. Phantom Trade Error (Line 402-405)
```typescript
await updateTrade(env, trade.id, {
  status: 'EXIT_ERROR',
  exit_reason: 'PHANTOM_TRADE',
});
```
- ✅ Only updates: `status`, `exit_reason`
- ✅ Does NOT touch core fields

#### 2. Quantity Mismatch Error (Line 798-801)
```typescript
await updateTrade(env, trade.id, {
  status: 'EXIT_ERROR',
  exit_reason: 'QUANTITY_MISMATCH',
});
```
- ✅ Only updates: `status`, `exit_reason`
- ✅ Does NOT touch core fields

#### 3. Quantity Mismatch Error (Retry Path) (Line 1103-1106)
```typescript
await updateTrade(env, trade.id, {
  status: 'EXIT_ERROR',
  exit_reason: 'QUANTITY_MISMATCH',
});
```
- ✅ Only updates: `status`, `exit_reason`
- ✅ Does NOT touch core fields

#### 4. Quantity Adjustment (Line 1838-1848)
```typescript
updatedTrade = await updateTrade(env, trade.id, {
  quantity: availableQty,
  max_profit: perContractMaxProfit !== null
    ? perContractMaxProfit * availableQty
    : trade.max_profit,
  max_loss: perContractMaxLoss !== null
    ? perContractMaxLoss * availableQty
    : trade.max_loss,
});
```
- ✅ Updates: `quantity`, `max_profit`, `max_loss`
- ✅ **This is CORRECT** - adjusts quantity to match broker reality when available quantity < recorded quantity
- ✅ `quantity` is NOT a protected field (can be updated)
- ✅ `max_profit`/`max_loss` are recalculated proportionally (correct behavior)
- ✅ Does NOT touch core fields

### ✅ Lifecycle Function Calls

**`markTradeClosed`** (Line 538):
- Called when exit order is filled
- ✅ Only updates: `status`, `exit_price`, `closed_at`, `realized_pnl`, `exit_reason`
- ✅ Does NOT touch core fields

**`markTradeClosingPending`** (Line 505):
- Called when exit order is submitted
- ✅ Only updates: `status`, `exit_reason`, `broker_order_id_close`
- ✅ Does NOT touch core fields

## MonitorCycle.ts Verification

### ✅ All `updateTrade` Calls Reviewed

**Location:** `worker/src/cron/monitorCycle.ts`

#### 1. Phantom Trade Error (Line 166-169)
```typescript
await updateTrade(env, trade.id, {
  status: 'EXIT_ERROR',
  exit_reason: 'PHANTOM_TRADE',
});
```
- ✅ Only updates: `status`, `exit_reason`
- ✅ Does NOT touch core fields

#### 2. Phantom Trade Error (Close Phantom Trades) (Line 435-438)
```typescript
await updateTrade(env, trade.id, {
  status: 'EXIT_ERROR',
  exit_reason: 'PHANTOM_TRADE',
});
```
- ✅ Only updates: `status`, `exit_reason`
- ✅ Does NOT touch core fields

#### 3. Manual Close (Line 463-468)
```typescript
await updateTrade(env, trade.id, {
  status: 'CLOSED',
  exit_reason: 'MANUAL_CLOSE',
  closed_at: new Date().toISOString(),
  realized_pnl: null,
});
```
- ✅ Only updates: `status`, `exit_reason`, `closed_at`, `realized_pnl`
- ✅ Does NOT touch core fields

#### 4. Cancelled Trade (Line 471-474)
```typescript
await updateTrade(env, trade.id, {
  status: 'CANCELLED',
  exit_reason: 'UNKNOWN',
});
```
- ✅ Only updates: `status`, `exit_reason`
- ✅ Does NOT touch core fields

### ✅ Functions Called by MonitorCycle

**`executeExitForTrade`** (from `exits.ts`):
- ✅ Already verified above - only updates appropriate fields

**`evaluateOpenTrade`** (from `monitoring.ts`):
- ✅ Only updates `max_seen_profit_fraction` (line 493-494)
- ✅ Does NOT touch core fields

**`checkPendingExits`** (from `exits.ts`):
- ✅ Uses `markTradeClosed` lifecycle function
- ✅ Does NOT touch core fields

**`checkPendingEntries`** (from `entry.ts`):
- ✅ Uses `markTradeOpen` lifecycle function
- ✅ Does NOT touch core fields

## TradeCycle.ts Verification

### ✅ No Direct `updateTrade` Calls

**Location:** `worker/src/cron/tradeCycle.ts`

- ✅ Does NOT call `updateTrade` directly
- ✅ Calls `attemptEntryForLatestProposal` (from `entry.ts`)
- ✅ `attemptEntryForLatestProposal` uses `insertTrade` (creates new trade) and `markTradeOpen` (lifecycle function)
- ✅ Does NOT touch existing trades' core fields

### ✅ Functions Called by TradeCycle

**`attemptEntryForLatestProposal`** (from `entry.ts`):
- ✅ Creates new trades via `insertTrade` (line 847)
- ✅ Uses `markTradeOpen` lifecycle function (line 1061)
- ✅ Does NOT modify existing trades

**`generateProposal`** (from `proposals.ts`):
- ✅ Only creates proposals, does NOT modify trades

## Summary of All Updates

### Fields That CAN Be Updated (Non-Core)

| Field | Updated By | Purpose |
|-------|-----------|---------|
| `status` | exits.ts, monitorCycle.ts, lifecycle.ts | Trade lifecycle state |
| `exit_reason` | exits.ts, monitorCycle.ts, lifecycle.ts | Reason for exit |
| `broker_order_id_close` | lifecycle.ts | Close order ID |
| `exit_price` | lifecycle.ts | Price at exit |
| `closed_at` | lifecycle.ts, monitorCycle.ts | Timestamp when closed |
| `realized_pnl` | lifecycle.ts, monitorCycle.ts | Calculated PnL |
| `quantity` | exits.ts (quantity adjustment), portfolioSync.ts | Adjust to match broker reality |
| `max_profit` | exits.ts (quantity adjustment), portfolioSync.ts, lifecycle.ts | Recalculated when quantity changes |
| `max_loss` | exits.ts (quantity adjustment), portfolioSync.ts, lifecycle.ts | Recalculated when quantity changes |
| `max_seen_profit_fraction` | monitoring.ts | Updated during monitoring |
| `entry_price` | lifecycle.ts, portfolioSync.ts, orderSync.ts | Set when trade opens |
| `opened_at` | lifecycle.ts | Timestamp when opened |
| `iv_entry` | lifecycle.ts | IV at entry |

### Fields That CANNOT Be Updated (Protected Core Fields)

| Field | Protection |
|-------|-----------|
| `proposal_id` | ✅ Protected - cannot be overwritten |
| `symbol` | ✅ Protected - cannot be overwritten |
| `expiration` | ✅ Protected - cannot be overwritten |
| `short_strike` | ✅ Protected - cannot be overwritten |
| `long_strike` | ✅ Protected - cannot be overwritten |
| `width` | ✅ Protected - cannot be overwritten |
| `strategy` | ✅ Protected - cannot be overwritten (except data integrity fixes) |
| `broker_order_id_open` | ✅ Protected by logic - only backfilled if null |

## Verification Checklist

- [x] `exits.ts` - All `updateTrade` calls only update status/exit fields
- [x] `exits.ts` - Quantity adjustment is appropriate (matches broker reality)
- [x] `exits.ts` - Lifecycle functions used correctly
- [x] `monitorCycle.ts` - All `updateTrade` calls only update status/exit fields
- [x] `monitorCycle.ts` - No core fields overwritten
- [x] `tradeCycle.ts` - No direct trade updates (only creates new trades)
- [x] All lifecycle functions preserve core fields
- [x] `updateTrade` protection prevents accidental overwrites

## Conclusion

✅ **All exits.ts and cron job updates are safe**
✅ **No core fields are overwritten**
✅ **Only appropriate fields are updated (status, exit_reason, prices, timestamps, quantity adjustments)**
✅ **Protection in `updateTrade` prevents accidental overwrites**

The system correctly maintains data integrity by:
1. Only updating non-core fields in exits and monitoring
2. Using lifecycle functions that preserve core fields
3. Having explicit protection in `updateTrade` to prevent overwrites
4. Adjusting quantity/max_profit/max_loss when broker reality differs (correct behavior)

