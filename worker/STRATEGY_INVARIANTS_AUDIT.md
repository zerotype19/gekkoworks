# Strategy Invariants Audit Report

## Summary

This document confirms that strategy + strike/leg relationships are consistent across the entire codebase.

## Invariant Definitions

All strategies follow these rules:

### BULL_PUT_CREDIT
- **Legs:** PUTs
- **Strike relationship:** `short_strike > long_strike` (e.g., short 640, long 635)
- **Entry:** SELL_TO_OPEN higher strike (short), BUY_TO_OPEN lower strike (long)
- **Max profit:** ≈ credit; **Max loss:** ≈ width - credit

### BEAR_CALL_CREDIT
- **Legs:** CALLs
- **Strike relationship:** `short_strike < long_strike` (e.g., short 640, long 645)
- **Entry:** SELL_TO_OPEN lower strike (short), BUY_TO_OPEN higher strike (long)
- **Max profit:** ≈ credit; **Max loss:** ≈ width - credit

### BULL_CALL_DEBIT
- **Legs:** CALLs
- **Strike relationship:** `long_strike < short_strike` (e.g., long 635, short 640)
- **Entry:** BUY_TO_OPEN lower strike (long), SELL_TO_OPEN higher strike (short)
- **Net debit:** credit stored as negative in candidates/trades
- **Max profit:** ≈ width - debit; **Max loss:** ≈ debit

### BEAR_PUT_DEBIT
- **Legs:** PUTs
- **Strike relationship:** `long_strike > short_strike` (e.g., long 645, short 640)
- **Entry:** BUY_TO_OPEN higher strike (long), SELL_TO_OPEN lower strike (short)
- **Net debit:** credit stored as negative in candidates/trades
- **Max profit:** ≈ width - debit; **Max loss:** ≈ debit

## Code Verification

### ✅ Strategy Builders (All Correct)

**`buildBullPutCreditCandidates`** (`strategy/bullPutCredit.ts`):
- Sets `short_strike: shortPut.strike` (higher strike)
- Sets `long_strike: longPut.strike` (lower strike, calculated as `shortPut.strike - WIDTH`)
- ✅ Correct: short_strike > long_strike

**`buildBearCallCreditCandidates`** (`strategy/bearCallCredit.ts`):
- Sets `short_strike: shortCall.strike` (lower strike)
- Sets `long_strike: longCall.strike` (higher strike, calculated as `shortCall.strike + WIDTH`)
- ✅ Correct: short_strike < long_strike

**`buildBullCallDebitCandidates`** (`strategy/bullCallDebit.ts`):
- Sets `short_strike: shortCall.strike` (higher strike, calculated as `longCall.strike + WIDTH`)
- Sets `long_strike: longCall.strike` (lower strike)
- ✅ Correct: long_strike < short_strike

**`buildBearPutDebitCandidates`** (`strategy/bearPutDebit.ts`):
- Sets `short_strike: shortPut.strike` (lower strike, calculated as `longPut.strike - WIDTH`)
- Sets `long_strike: longPut.strike` (higher strike)
- ✅ Correct: long_strike > short_strike

### ✅ Entry Order Construction (`engine/entry.ts`)

**Credit Spreads (BULL_PUT_CREDIT, BEAR_CALL_CREDIT):**
- `leg0` = short leg (SELL_TO_OPEN)
- `leg1` = long leg (BUY_TO_OPEN)
- ✅ Correct: Uses `shortOption.symbol` and `longOption.symbol` from proposal

**Debit Spreads (BULL_CALL_DEBIT, BEAR_PUT_DEBIT):**
- `leg0` = long leg (BUY_TO_OPEN)
- `leg1` = short leg (SELL_TO_OPEN)
- ✅ Correct: Uses `longOption.symbol` and `shortOption.symbol` from proposal

**Invariant Check Added:**
- Before placing entry order, `checkStrategyInvariants` is called
- Throws error if violations detected
- Logs `[entry][strategy][order_build]` with invariant check result

### ✅ Exit Order Construction (`engine/exits.ts`)

**Credit Spread Exits:**
- `leg0` = short leg (BUY_TO_CLOSE)
- `leg1` = long leg (SELL_TO_CLOSE)
- ✅ Correct: Reverses entry directions

**Debit Spread Exits:**
- `leg0` = long leg (SELL_TO_CLOSE)
- `leg1` = short leg (BUY_TO_CLOSE)
- ✅ Correct: Reverses entry directions

**Invariant Check Added:**
- Before placing exit order, `checkStrategyInvariants` is called
- Logs violations but doesn't block exit (allows repair)
- Logs `[exit][strategy][order_build]` with invariant check result

### ✅ Trade Creation (`engine/entry.ts`)

**Trade Insertion:**
- Copies `short_strike`, `long_strike`, `width`, `strategy` directly from proposal
- ✅ Correct: No transformation or reordering

**Database Schema:**
- `trades` table stores `short_strike`, `long_strike`, `width`, `strategy` as-is
- ✅ Correct: No numeric ordering applied

### ✅ Portfolio Sync (`engine/portfolioSync.ts`)

**`groupPositionsIntoSpreads`:**
- Uses position quantity sign to determine short vs long:
  - Negative quantity → short leg
  - Positive quantity → long leg
- Sets `short_strike` and `long_strike` based on role, not numeric ordering
- ✅ Correct: `shortStrike = shortParsed.strike` (the one with negative quantity)
- ✅ Correct: `longStrike = longParsed.strike` (the one with positive quantity)

### ✅ Lifecycle Validation (`engine/lifecycle.ts`)

**`validateSpreadInvariants`:**
- Verifies strike relationships match strategy:
  - BULL_PUT_CREDIT: `expectedLongStrike = short_strike - width`
  - BEAR_CALL_CREDIT: `expectedLongStrike = short_strike + width`
  - BULL_CALL_DEBIT: `expectedLongStrike = short_strike - width`
  - BEAR_PUT_DEBIT: `expectedLongStrike = short_strike + width`
- ✅ Correct: Matches strategy builder logic

### ✅ Monitoring Validation (`engine/monitoring.ts`)

**`checkStructuralIntegrity`:**
- Uses same strike relationship logic as `validateSpreadInvariants`
- ✅ Correct: Consistent with lifecycle validation

### ✅ Order Building (`broker/tradierClient.ts`)

**`placeSpreadOrder`:**
- Receives legs with `option_symbol` and `side` already set
- Does NOT reorder or transform strikes
- ✅ Correct: Passes through leg construction from entry/exits

## New Helper Module

**`core/strategyInvariants.ts`** created with:
- `checkStrategyInvariants(trade)`: Validates trade against invariants
- `checkStrategyAgainstLegs(trade, legs)`: Validates trade against actual broker legs

## Debug Endpoint

**`/debug/strategy-invariants`** created:
- Loads all trades (up to 1000)
- Runs `checkStrategyInvariants` on each
- Returns summary with violations by type
- Logs all violations with `[strategy][invariants]` prefix

## Verification Status

✅ **All strategy builders use role-based strike assignment (not numeric ordering)**
✅ **Entry order construction correctly maps strikes to legs**
✅ **Exit order construction correctly reverses entry directions**
✅ **Trade insertion preserves proposal strikes without transformation**
✅ **Portfolio sync uses quantity sign to determine short/long (role-based)**
✅ **Lifecycle and monitoring validation use consistent strike relationship logic**
✅ **Order building passes through leg construction without modification**

## Next Steps

1. **Run the audit endpoint:** `GET /debug/strategy-invariants` to check existing trades
2. **Review violations:** If any violations are found, investigate root cause
3. **Monitor logs:** Watch for `[entry][strategy][order_build]` and `[exit][strategy][order_build]` logs
4. **Test in SANDBOX:** Verify new trades pass invariant checks

## Notes

- The `regimeConfidence` import error in `entry.ts` is pre-existing and unrelated to this audit
- All strategy builders correctly assign strikes based on role (short/long), not numeric ordering
- The invariant checker will catch any future violations at entry/exit time

