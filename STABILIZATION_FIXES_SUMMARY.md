# Stabilization Phase Fixes - Summary

**Date**: Current  
**Purpose**: Fix mathematical/logical issues identified in strategy rules to stop bleeding and stabilize the system

---

## Changes Applied

### 1. ✅ Removed EV as Hard Filter

**Problem**: EV formula (`POP × max_profit - (1-POP) × max_loss`) was blocking good trades because:
- It assumes all losers take full max loss (unrealistic)
- With realistic deltas (0.65-0.75 POP) and credits ($0.70-$1.20), EV is usually negative
- This was rejecting perfectly valid trades

**Solution**: 
- Removed EV hard filter check (it was already not enforced in code)
- Updated documentation to clarify EV is informational only
- EV may still be computed but does NOT reject candidates

**Files Changed**:
- `worker/src/core/metrics.ts` - Updated comment to clarify EV is not a hard filter
- `docs/strategy-rules-complete.md` - Updated EV section to reflect it's informational only

---

### 2. ✅ Exit Priority Order Fixed

**Problem**: Exit triggers were not in the correct priority order:
- TIME_EXIT was checked before PROFIT_TARGET/STOP_LOSS
- This could cause trades to close on time before profit/loss targets

**Solution**: 
- Reordered exit evaluation to: EMERGENCY → PROFIT_TARGET → STOP_LOSS → TIME_EXIT
- Moved TIME_EXIT check to end of `evaluateCloseRules` function
- PnL-based exits now take precedence over time-based exits

**Files Changed**:
- `worker/src/engine/monitoring.ts` - Moved TIME_EXIT check to after PROFIT_TARGET and STOP_LOSS
- `docs/strategy-rules-complete.md` - Updated exit priority order documentation

---

### 3. ✅ Lowered Minimum Credit Fraction

**Problem**: 18% minimum credit ($0.90 for 5-wide) was too restrictive:
- In calmer vol regimes, many valid spreads price at $0.60-$0.90
- System was starving for trades

**Solution**: 
- Lowered `minCreditFraction` from 0.18 to 0.16 (16% = $0.80 for 5-wide)
- Made it configurable via `MIN_CREDIT_FRACTION` setting
- Kept absolute floor at $0.60

**Files Changed**:
- `worker/src/core/config.ts` - Changed default from 0.18 to 0.16
- `worker/src/strategy/config.ts` - Updated all strategy configs from 0.18 to 0.16
- `docs/strategy-rules-complete.md` - Updated credit requirements

---

### 4. 🔄 Disable BEAR_CALL_CREDIT (Ready to Apply)

**Problem**: BEAR_CALL_CREDIT likely fighting the tape:
- SPY has been in strong up/sideways regime
- Bear call spreads get steamrolled in grind-up markets
- Contributing to losses

**Solution**: 
- Created script to disable BEAR_CALL_CREDIT via strategy whitelist
- Set `PROPOSAL_STRATEGY_WHITELIST = BULL_PUT_CREDIT` only
- Can re-enable later with trend filter (e.g., only when SPY < 50-day SMA)

**Files Created**:
- `worker/apply-stabilization-settings.sh` - Script to apply BEAR_CALL_CREDIT disable and min credit update

**To Apply**:
```bash
cd worker
./apply-stabilization-settings.sh https://gekkoworks-api.kevin-mcgovern.workers.dev
```

---

## What Was NOT Changed

As requested, these remain unchanged:
- ✅ Stop loss threshold: 10% of max loss
- ✅ Profit target: 50% of max profit  
- ✅ DTE window: 30-35 days
- ✅ IVR filters
- ✅ Risk caps (MAX_TRADE_LOSS_DOLLARS, DAILY_MAX_NEW_RISK, etc.)

---

## Next Steps

1. **Apply Stabilization Settings**:
   ```bash
   cd worker
   ./apply-stabilization-settings.sh https://gekkoworks-api.kevin-mcgovern.workers.dev
   ```

2. **Deploy Worker**:
   ```bash
   cd worker
   wrangler deploy
   ```

3. **Monitor Results**:
   - Check `/debug/pnl-summary` endpoint
   - Verify more proposals are passing filters
   - Confirm BEAR_CALL_CREDIT is disabled
   - Monitor exit priority behavior

---

## Expected Impact

- **More Trade Flow**: Lowered credit requirement (16% vs 18%) allows more valid trades
- **No EV Blocking**: EV no longer rejects good trades with negative EV
- **Better Exit Timing**: Profit/loss exits take precedence over time exits
- **Focused Strategy**: Only BULL_PUT_CREDIT active (should align better with current market regime)

---

## Verification Checklist

- [ ] Strategy whitelist shows only `BULL_PUT_CREDIT`
- [ ] Min credit fraction setting shows `0.16` (or 16%)
- [ ] Exit logs show correct priority order (PROFIT → STOP → TIME)
- [ ] More proposals are being generated (no EV blocking)
- [ ] No BEAR_CALL_CREDIT trades are being opened

---

**Status**: All code changes complete. Ready to deploy and apply settings.

