# Order Structure Comparison: Current vs Required

## Critical Issues Found

### 1. ❌ **TYPE NOT FLIPPED FOR EXIT ORDERS** (CRITICAL BUG)

**Current Implementation:**
- Determines `type` based ONLY on strategy name:
  - `strategy.endsWith('_CREDIT')` → `type=credit`
  - `strategy.endsWith('_DEBIT')` → `type=debit`
- Does NOT consider `params.side` (ENTRY vs EXIT)
- Result: EXIT orders use the same type as ENTRY orders (WRONG!)

**Required (per instructions):**
- **ENTRY orders:**
  - Credit spreads → `type=credit`
  - Debit spreads → `type=debit`
- **EXIT orders:**
  - Credit spreads → `type=debit` (we pay to close)
  - Debit spreads → `type=credit` (we receive credit to close)

**Impact:** This is causing Tradier to reject exit orders because the type doesn't match the actual transaction direction.

---

### 2. ✅ Leg Structures (Mostly Correct)

#### BULL_PUT_CREDIT
**OPEN:**
- ✅ Current: leg0 = short (sell_to_open), leg1 = long (buy_to_open)
- ✅ Required: side[0]=sell_to_open (short), side[1]=buy_to_open (long)

**CLOSE:**
- ✅ Current: leg0 = short (buy_to_close), leg1 = long (sell_to_close)
- ✅ Required: side[0]=buy_to_close (short), side[1]=sell_to_close (long)
- ❌ **BUT:** Current sends `type=credit`, should be `type=debit`

#### BEAR_PUT_DEBIT
**OPEN:**
- ✅ Current: leg0 = long (buy_to_open), leg1 = short (sell_to_open)
- ✅ Required: side[0]=buy_to_open (long higher), side[1]=sell_to_open (short lower)

**CLOSE:**
- ✅ Current: leg0 = long (sell_to_close), leg1 = short (buy_to_close)
- ✅ Required: side[0]=sell_to_close (long), side[1]=buy_to_close (short)
- ❌ **BUT:** Current sends `type=debit`, should be `type=credit`

#### BULL_CALL_DEBIT
**OPEN:**
- ✅ Current: leg0 = long (buy_to_open), leg1 = short (sell_to_open)
- ✅ Required: side[0]=buy_to_open (long lower), side[1]=sell_to_open (short higher)

**CLOSE:**
- ✅ Current: leg0 = long (sell_to_close), leg1 = short (buy_to_close)
- ✅ Required: side[0]=sell_to_close (long), side[1]=buy_to_close (short)
- ❌ **BUT:** Current sends `type=debit`, should be `type=credit`

#### BEAR_CALL_CREDIT
**OPEN:**
- ✅ Current: leg0 = short (sell_to_open), leg1 = long (buy_to_open)
- ✅ Required: side[0]=sell_to_open (short lower), side[1]=buy_to_open (long higher)

**CLOSE:**
- ✅ Current: leg0 = short (buy_to_close), leg1 = long (sell_to_close)
- ✅ Required: side[0]=buy_to_close (short), side[1]=sell_to_close (long)
- ❌ **BUT:** Current sends `type=credit`, should be `type=debit`

---

### 3. ✅ Other Fields (Correct)

- ✅ `class=multileg` - correct
- ✅ `symbol` - correct
- ✅ `duration=day` - correct
- ✅ `price` - correct (net credit/debit)
- ✅ `side[i]`, `quantity[i]`, `option_symbol[i]` - correct format
- ✅ `tag` - correct

---

## Summary

**Main Issue:** Type determination doesn't flip for EXIT orders. This is causing Tradier rejections.

**Fix Required:** ✅ **FIXED** - Updated `placeSpreadOrder` in `tradierClient.ts` to:
1. Check `params.side` (ENTRY vs EXIT)
2. For ENTRY: use strategy-based type (credit/debit)
3. For EXIT: FLIP the type (credit → debit, debit → credit)

---

## Detailed Leg Structure Verification

### BULL_PUT_CREDIT
**Strike Assignment:**
- ✅ short_strike = higher strike (from strategy builder)
- ✅ long_strike = lower strike (short - 5)

**OPEN Leg Order:**
- ✅ Current: leg0 = short (sell_to_open), leg1 = long (buy_to_open)
- ✅ Required: side[0]=sell_to_open (short higher), side[1]=buy_to_open (long lower)
- ✅ **MATCHES**

**CLOSE Leg Order:**
- ✅ Current: leg0 = short (buy_to_close), leg1 = long (sell_to_close)
- ✅ Required: side[0]=buy_to_close (short), side[1]=sell_to_close (long)
- ✅ **MATCHES** (after type fix)

### BEAR_PUT_DEBIT
**Strike Assignment:**
- ✅ short_strike = lower strike (from strategy builder)
- ✅ long_strike = higher strike (short + 5)

**OPEN Leg Order:**
- ✅ Current: leg0 = long (buy_to_open), leg1 = short (sell_to_open)
- ✅ Required: side[0]=buy_to_open (long higher), side[1]=sell_to_open (short lower)
- ✅ **MATCHES**

**CLOSE Leg Order:**
- ✅ Current: leg0 = long (sell_to_close), leg1 = short (buy_to_close)
- ✅ Required: side[0]=sell_to_close (long), side[1]=buy_to_close (short)
- ✅ **MATCHES** (after type fix)

### BULL_CALL_DEBIT
**Strike Assignment:**
- ✅ short_strike = higher strike (from strategy builder)
- ✅ long_strike = lower strike (short - 5)

**OPEN Leg Order:**
- ✅ Current: leg0 = long (buy_to_open), leg1 = short (sell_to_open)
- ✅ Required: side[0]=buy_to_open (long lower), side[1]=sell_to_open (short higher)
- ✅ **MATCHES**

**CLOSE Leg Order:**
- ✅ Current: leg0 = long (sell_to_close), leg1 = short (buy_to_close)
- ✅ Required: side[0]=sell_to_close (long), side[1]=buy_to_close (short)
- ✅ **MATCHES** (after type fix)

### BEAR_CALL_CREDIT
**Strike Assignment:**
- ✅ short_strike = lower strike (from strategy builder)
- ✅ long_strike = higher strike (short + 5)

**OPEN Leg Order:**
- ✅ Current: leg0 = short (sell_to_open), leg1 = long (buy_to_open)
- ✅ Required: side[0]=sell_to_open (short lower), side[1]=buy_to_open (long higher)
- ✅ **MATCHES**

**CLOSE Leg Order:**
- ✅ Current: leg0 = short (buy_to_close), leg1 = long (sell_to_close)
- ✅ Required: side[0]=buy_to_close (short), side[1]=sell_to_close (long)
- ✅ **MATCHES** (after type fix)

---

## Final Status

✅ **Leg structures are correct** - All strategies match the required leg order
✅ **Type flipping for EXIT is now fixed** - EXIT orders will use the correct flipped type
✅ **All other fields are correct** - class, symbol, duration, price, indexed params all match

**The only issue was the type flipping, which is now fixed.**

