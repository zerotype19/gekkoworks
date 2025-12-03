# Core Fields Protection - Verification Report

## Summary

All core trade fields are now protected from being overwritten by monitoring, lifecycle, and portfolio sync functions. The `updateTrade` function now includes explicit protection for immutable fields.

## Protected Fields (Never Overwritten)

These fields can only be set at trade creation and **must never be changed**:

1. **`proposal_id`** - Links trade to its proposal
2. **`symbol`** - Underlying symbol
3. **`expiration`** - Option expiration date
4. **`short_strike`** - Short leg strike price
5. **`long_strike`** - Long leg strike price
6. **`width`** - Spread width
7. **`strategy`** - Trade strategy (with exception for data integrity fixes)

### Strategy Field Exception

The `strategy` field can be updated **only if**:
- Current value is `null` or `undefined` (initial creation)
- Current value is the default `'BULL_PUT_CREDIT'` (might be incorrectly set)

This allows `debugBackfillMissingTrades` to fix incorrect strategies while preventing accidental overwrites of correct values.

## Trade Creation (entry.ts)

### ✅ All Core Fields Populated Correctly

**Location:** `worker/src/engine/entry.ts:810-831`

```typescript
const trade: Omit<TradeRow, 'created_at' | 'updated_at'> = {
  id: crypto.randomUUID(),
  proposal_id: proposal.id, // ✅ From proposal
  symbol: proposal.symbol, // ✅ From proposal
  expiration: proposal.expiration, // ✅ From proposal
  short_strike: proposal.short_strike, // ✅ From proposal
  long_strike: proposal.long_strike, // ✅ From proposal
  width: proposal.width, // ✅ From proposal
  quantity: proposal.quantity ?? 1, // ✅ From proposal
  strategy: proposal.strategy, // ✅ From proposal
  broker_order_id_open: order.id, // ✅ From Tradier order
  status: 'ENTRY_PENDING',
  // ... other fields
};
```

### ✅ Validations in Place

**Location:** `worker/src/engine/entry.ts:834-845`

- `proposal_id` - Validated (must not be null)
- `strategy` - Validated (must not be null, must match proposal)
- `broker_order_id_open` - Validated (must not be null)

## Update Functions - Field Protection

### ✅ `updateTrade` Protection

**Location:** `worker/src/db/queries.ts:99-131`

The `updateTrade` function now:
1. Fetches current trade before updating
2. Checks if any protected fields are being overwritten
3. Throws error if protected field is already set and being changed
4. Allows setting protected fields if current value is null/undefined

### ✅ Lifecycle Functions (lifecycle.ts)

**`markTradeOpen`** (line 88-95):
- Updates: `status`, `entry_price`, `opened_at`, `max_profit`, `max_loss`, `iv_entry`
- ✅ Does NOT touch core fields

**`markTradeClosingPending`** (line 516-520):
- Updates: `status`, `exit_reason`, `broker_order_id_close`
- ✅ Does NOT touch core fields

**`markTradeClosed`** (line 618-624):
- Updates: `status`, `exit_price`, `closed_at`, `realized_pnl`, `exit_reason`
- ✅ Does NOT touch core fields

### ✅ Monitoring (monitoring.ts)

**Location:** `worker/src/engine/monitoring.ts:493-494`

- Updates: `max_seen_profit_fraction` only
- ✅ Does NOT touch core fields

### ✅ Order Sync (orderSync.ts)

**Location:** `worker/src/engine/orderSync.ts:189-191, 418-420`

- Updates: `broker_order_id_open` (backfilling missing IDs)
- ✅ Does NOT touch core fields
- ✅ Only sets `broker_order_id_open` if it's currently null

### ✅ Portfolio Sync (portfolioSync.ts)

**Location:** `worker/src/engine/portfolioSync.ts:384-458`

**Fixed Issues:**
1. ✅ **Max Profit/Loss Calculation** - Now uses trade's actual `strategy` field instead of assuming credit spread
2. ✅ **Entry Price Calculation** - Correctly handles both credit and debit spreads
3. ✅ **Protected Fields** - Only updates `quantity`, `entry_price`, `max_profit`, `max_loss`
4. ✅ **Comments Updated** - Clarified that it preserves `broker_order_id_open` and `broker_order_id_close`

**Updates Made:**
- `quantity` - Only if currently null
- `entry_price` - Only if currently null or <= 0
- `max_profit` - Calculated based on trade's actual strategy
- `max_loss` - Calculated based on trade's actual strategy

**Does NOT Update:**
- `proposal_id` ✅
- `symbol` ✅
- `expiration` ✅
- `short_strike` ✅
- `long_strike` ✅
- `width` ✅
- `strategy` ✅
- `broker_order_id_open` ✅ (preserved, backfilled by orderSync)
- `broker_order_id_close` ✅ (preserved)

### ✅ Exit Functions (exits.ts)

All `updateTrade` calls in `exits.ts` only update:
- `status`
- `exit_reason`
- `broker_order_id_close`
- Error status fields

✅ Does NOT touch core fields

### ✅ Debug Backfill (debugBackfillMissingTrades.ts)

**Location:** `worker/src/http/debugBackfillMissingTrades.ts:182-205`

**Allowed Updates:**
- `quantity` - If mismatch detected
- `strategy` - Only if current is null or incorrect (protected by updateTrade logic)

**Does NOT Update:**
- `proposal_id` ✅
- `symbol` ✅
- `expiration` ✅
- `short_strike` ✅
- `long_strike` ✅
- `width` ✅
- `broker_order_id_open` ✅ (backfilled by orderSync)

## Verification Checklist

- [x] `entry.ts` populates all core fields from proposal
- [x] `updateTrade` protects core fields from overwriting
- [x] `lifecycle.ts` functions only update appropriate fields
- [x] `monitoring.ts` only updates `max_seen_profit_fraction`
- [x] `orderSync.ts` only backfills `broker_order_id_open`
- [x] `portfolioSync.ts` uses trade's actual strategy for calculations
- [x] `portfolioSync.ts` does not overwrite core fields
- [x] `exits.ts` does not overwrite core fields
- [x] All validations in place for trade creation

## Testing

To verify protection is working:

1. **Test Protected Field Overwrite:**
   ```typescript
   // This should throw an error
   await updateTrade(env, tradeId, { symbol: 'AAPL' }); // If symbol already set
   ```

2. **Test Strategy Update (Allowed):**
   ```typescript
   // This should work if current strategy is null or 'BULL_PUT_CREDIT'
   await updateTrade(env, tradeId, { strategy: 'BULL_CALL_DEBIT' });
   ```

3. **Test Strategy Update (Blocked):**
   ```typescript
   // This should throw if current strategy is already 'BULL_CALL_DEBIT'
   await updateTrade(env, tradeId, { strategy: 'BULL_PUT_CREDIT' });
   ```

## Summary

✅ **All core fields are protected from accidental overwriting**
✅ **Portfolio sync now correctly calculates max_profit/max_loss based on trade strategy**
✅ **All update functions only modify appropriate fields**
✅ **Trade creation includes all required validations**

The system now ensures data integrity by preventing core trade fields from being modified after creation, while still allowing necessary updates (like backfilling order IDs or fixing data integrity issues).

