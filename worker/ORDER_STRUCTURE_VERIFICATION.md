# Order Structure Verification

This document verifies that proposals are correctly aligned with order placement for each strategy type.

## BEAR_PUT_DEBIT (Bear Put Debit Spread)

### Proposal Generation (`bearPutDebit.ts`)
- Finds long put at strike with delta 0.40-0.55 (e.g., $180 Put)
- Calculates short strike: `shortStrike = longPut.strike - WIDTH` (e.g., 180 - 5 = 175)
- Proposal structure:
  - `short_strike: 175` (lower strike)
  - `long_strike: 180` (higher strike)
  - Relationship: `long_strike > short_strike` ✓

### Order Construction (`entry.ts`)
- Finds options: `shortOption` at strike 175, `longOption` at strike 180
- For debit spreads: `leg0 = long (buy_to_open)`, `leg1 = short (sell_to_open)`
- Order structure:
  - `leg0`: Buy To Open $180 Put ✓
  - `leg1`: Sell To Open $175 Put ✓

### Verification
✅ **CORRECT**: Matches Tradier orders (Buy To Open $180 Put, Sell To Open $175 Put)

---

## BULL_CALL_DEBIT (Bull Call Debit Spread)

### Proposal Generation (`bullCallDebit.ts`)
- Finds long call at strike with delta 0.40-0.55 (e.g., $280 Call)
- Calculates short strike: `shortStrike = longCall.strike + WIDTH` (e.g., 280 + 5 = 285)
- Proposal structure:
  - `short_strike: 285` (higher strike)
  - `long_strike: 280` (lower strike)
  - Relationship: `long_strike < short_strike` ✓

### Order Construction (`entry.ts`)
- Finds options: `shortOption` at strike 285, `longOption` at strike 280
- For debit spreads: `leg0 = long (buy_to_open)`, `leg1 = short (sell_to_open)`
- Order structure:
  - `leg0`: Buy To Open $280 Call ✓
  - `leg1`: Sell To Open $285 Call ✓

### Verification
✅ **CORRECT**: Matches Tradier orders (Buy To Open $280 Call, Sell To Open $285 Call)

---

## BULL_PUT_CREDIT (Bull Put Credit Spread)

### Proposal Generation (`bullPutCredit.ts`)
- Finds short put at strike with delta -0.25 to -0.35 (e.g., $450 Put)
- Calculates long strike: `longStrike = shortPut.strike - WIDTH` (e.g., 450 - 5 = 445)
- Proposal structure:
  - `short_strike: 450` (higher strike)
  - `long_strike: 445` (lower strike)
  - Relationship: `short_strike > long_strike` ✓

### Order Construction (`entry.ts`)
- Finds options: `shortOption` at strike 450, `longOption` at strike 445
- For credit spreads: `leg0 = short (sell_to_open)`, `leg1 = long (buy_to_open)`
- Order structure:
  - `leg0`: Sell To Open $450 Put ✓
  - `leg1`: Buy To Open $445 Put ✓

### Verification
✅ **CORRECT**: Standard credit spread structure

---

## BEAR_CALL_CREDIT (Bear Call Credit Spread)

### Proposal Generation (`bearCallCredit.ts`)
- Finds short call at strike with delta 0.25 to 0.35 (e.g., $450 Call)
- Calculates long strike: `longStrike = shortCall.strike + WIDTH` (e.g., 450 + 5 = 455)
- Proposal structure:
  - `short_strike: 450` (lower strike)
  - `long_strike: 455` (higher strike)
  - Relationship: `short_strike < long_strike` ✓

### Order Construction (`entry.ts`)
- Finds options: `shortOption` at strike 450, `longOption` at strike 455
- For credit spreads: `leg0 = short (sell_to_open)`, `leg1 = long (buy_to_open)`
- Order structure:
  - `leg0`: Sell To Open $450 Call ✓
  - `leg1`: Buy To Open $455 Call ✓

### Verification
✅ **CORRECT**: Standard credit spread structure

---

## Summary

All strategies are correctly aligned:
- ✅ Proposal generation sets `short_strike` and `long_strike` correctly
- ✅ Entry order construction uses the correct strikes from proposals
- ✅ Leg ordering matches strategy type (debit vs credit)
- ✅ Side assignment (buy_to_open vs sell_to_open) is correct for each leg
- ✅ Order structure matches Tradier's requirements

