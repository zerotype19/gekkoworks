# Trades D1 Table Columns - Complete Verification

## Table Structure (24 columns total)

Based on live D1 database inspection:

1. **id** - TEXT PRIMARY KEY
2. **proposal_id** - TEXT
3. **symbol** - TEXT NOT NULL
4. **expiration** - TEXT NOT NULL
5. **short_strike** - REAL NOT NULL
6. **long_strike** - REAL NOT NULL
7. **width** - REAL NOT NULL
8. **quantity** - INTEGER NOT NULL DEFAULT 1
9. **entry_price** - REAL
10. **exit_price** - REAL
11. **max_profit** - REAL
12. **max_loss** - REAL
13. **status** - TEXT NOT NULL
14. **exit_reason** - TEXT
15. **broker_order_id_open** - TEXT
16. **broker_order_id_close** - TEXT
17. **opened_at** - TEXT
18. **closed_at** - TEXT
19. **created_at** - TEXT NOT NULL
20. **updated_at** - TEXT NOT NULL
21. **realized_pnl** - REAL
22. **max_seen_profit_fraction** - REAL DEFAULT 0
23. **iv_entry** - REAL
24. **strategy** - TEXT DEFAULT 'BULL_PUT_CREDIT'

## Column Population Verification

### ✅ Always Populated at Creation (entry.ts:810-831)

| Column | Source | Validation | Status |
|--------|--------|------------|--------|
| `id` | `crypto.randomUUID()` | ✅ Always set | VERIFIED |
| `proposal_id` | `proposal.id` | ✅ Validated (line 834-835) | VERIFIED |
| `symbol` | `proposal.symbol` | ✅ From proposal | VERIFIED |
| `expiration` | `proposal.expiration` | ✅ From proposal | VERIFIED |
| `short_strike` | `proposal.short_strike` | ✅ From proposal | VERIFIED |
| `long_strike` | `proposal.long_strike` | ✅ From proposal | VERIFIED |
| `width` | `proposal.width` | ✅ From proposal | VERIFIED |
| `quantity` | `proposal.quantity ?? 1` | ✅ Defaults to 1 | VERIFIED |
| `strategy` | `proposal.strategy` | ✅ Validated (line 837-842) | **FIXED** - Now included in INSERT |
| `broker_order_id_open` | `order.id` | ✅ Validated (line 843-845) | VERIFIED |
| `status` | `'ENTRY_PENDING'` | ✅ Always set | VERIFIED |
| `created_at` | Auto-set by `insertTrade` | ✅ Always set | VERIFIED |
| `updated_at` | Auto-set by `insertTrade` | ✅ Always set | VERIFIED |

### ✅ Populated When Trade Opens (lifecycle.ts:markTradeOpen)

| Column | Source | Validation | Status |
|--------|--------|------------|--------|
| `entry_price` | `entryPrice` parameter | ✅ Validated > 0 (line 41-43) | VERIFIED |
| `opened_at` | `openedAt.toISOString()` | ✅ Always set | VERIFIED |
| `max_profit` | Calculated from `entryPrice` | ✅ Always calculated (line 85) | VERIFIED |
| `max_loss` | Calculated from `entryPrice` | ✅ Always calculated (line 86) | VERIFIED |
| `iv_entry` | `ivEntry` parameter (optional) | ✅ Set if provided (line 94) | VERIFIED |
| `status` | `'OPEN'` | ✅ Always set | VERIFIED |

**Note:** `iv_entry` is captured in entry.ts (line 949-959, 1061-1071) from option chain and passed to `markTradeOpen`.

### ✅ Populated When Trade Closes (lifecycle.ts:markTradeClosed)

| Column | Source | Validation | Status |
|--------|--------|------------|--------|
| `exit_price` | `exitPrice` parameter | ✅ Validated >= 0 (line 563-565, 614-616) | VERIFIED |
| `closed_at` | `closedAt.toISOString()` | ✅ Always set | VERIFIED |
| `realized_pnl` | Calculated from `entry_price` and `exit_price` | ✅ Validated not null (line 606-608) | VERIFIED |
| `exit_reason` | `exitReason` parameter | ✅ Always set (line 611) | VERIFIED |
| `status` | `'CLOSED'` | ✅ Always set | VERIFIED |

**Note:** `realized_pnl` calculation (line 591-603) handles both credit and debit spreads correctly.

### ✅ Populated When Exit Order Submitted (lifecycle.ts:markTradeClosingPending)

| Column | Source | Validation | Status |
|--------|--------|------------|--------|
| `broker_order_id_close` | `brokerOrderId` parameter | ✅ Always set (line 530) | VERIFIED |
| `exit_reason` | `reason` parameter | ✅ Always set (line 531) | VERIFIED |
| `status` | `'CLOSING_PENDING'` | ✅ Always set | VERIFIED |

### ✅ Updated During Monitoring (monitoring.ts:evaluateCloseRules)

| Column | Source | Validation | Status |
|--------|--------|------------|--------|
| `max_seen_profit_fraction` | Updated when profit increases (line 492-494) | ✅ Optional, defaults to 0 | VERIFIED |

### ⚠️ Columns That May Be Null (By Design)

| Column | When Null | Status |
|--------|-----------|--------|
| `proposal_id` | ❌ **SHOULD NEVER BE NULL** - Validated in entry.ts (line 834-835) | **VALIDATED** |
| `entry_price` | Only null before trade opens | ✅ Set by `markTradeOpen` | VERIFIED |
| `exit_price` | Only null before trade closes | ✅ Set by `markTradeClosed` | VERIFIED |
| `max_profit` | Only null before trade opens | ✅ Set by `markTradeOpen` | VERIFIED |
| `max_loss` | Only null before trade opens | ✅ Set by `markTradeOpen` | VERIFIED |
| `exit_reason` | Only null before exit triggered | ✅ Set by `markTradeClosingPending` or `markTradeClosed` | VERIFIED |
| `broker_order_id_open` | ❌ **SHOULD NEVER BE NULL** - Validated in entry.ts (line 843-845) | **VALIDATED** |
| `broker_order_id_close` | Only null before exit order placed | ✅ Set by `markTradeClosingPending` | VERIFIED |
| `opened_at` | Only null before trade opens | ✅ Set by `markTradeOpen` | VERIFIED |
| `closed_at` | Only null before trade closes | ✅ Set by `markTradeClosed` | VERIFIED |
| `realized_pnl` | Only null before trade closes | ✅ Set by `markTradeClosed` | VERIFIED |
| `iv_entry` | Optional - may be null if IV fetch fails | ✅ Optional field | VERIFIED |
| `max_seen_profit_fraction` | Defaults to 0, updated during monitoring | ✅ Optional field | VERIFIED |
| `strategy` | ❌ **SHOULD NEVER BE NULL** - Validated in entry.ts (line 837-839) | **FIXED** - Now included in INSERT |

## Critical Fixes Applied

### 1. ✅ `strategy` Column Added to INSERT Statement
   - **Issue:** `strategy` column exists in D1 but was missing from INSERT statement
   - **Fix:** Added `strategy` to INSERT columns and VALUES (queries.ts:45, 70)
   - **Status:** FIXED

### 2. ✅ `proposal_id` Validation
   - **Location:** entry.ts:834-835
   - **Status:** VALIDATED - Throws error if null

### 3. ✅ `broker_order_id_open` Validation
   - **Location:** entry.ts:843-845
   - **Status:** VALIDATED - Throws error if null

### 4. ✅ `entry_price` Validation
   - **Location:** lifecycle.ts:41-43
   - **Status:** VALIDATED - Throws error if <= 0

### 5. ✅ `exit_price` Validation
   - **Location:** lifecycle.ts:563-565, 614-616
   - **Status:** VALIDATED - Throws error if < 0

### 6. ✅ `realized_pnl` Validation
   - **Location:** lifecycle.ts:606-608, 629-631
   - **Status:** VALIDATED - Throws error if null/NaN

### 7. ✅ `strategy` Validation
   - **Location:** entry.ts:837-842
   - **Status:** VALIDATED - Throws error if null or mismatched

### 8. ✅ `exit_reason` Preserves Original Trigger
   - **Location:** exits.ts:513-520
   - **Status:** FIXED - Original monitoring trigger preserved instead of overwriting with BROKER_ALREADY_FLAT

## Summary

**All 24 columns are now properly handled:**

- ✅ **Always populated:** id, symbol, expiration, short_strike, long_strike, width, quantity, status, created_at, updated_at, proposal_id, broker_order_id_open, strategy
- ✅ **Populated when opened:** entry_price, opened_at, max_profit, max_loss, iv_entry (optional)
- ✅ **Populated when closed:** exit_price, closed_at, realized_pnl, exit_reason
- ✅ **Populated when exit submitted:** broker_order_id_close
- ✅ **Updated during monitoring:** max_seen_profit_fraction

**All critical validations are in place to ensure data integrity.**

