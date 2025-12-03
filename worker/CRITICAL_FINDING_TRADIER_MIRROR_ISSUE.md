# Critical Finding: Tradier Mirror Issue

## Problem Identified

**Date: 2025-12-02**

- **Our system shows**: 5 closed trades
- **Tradier shows**: 2 closed positions
- **Difference**: 3 trades

## Analysis

### Tradier Closed Positions
1. AAPL260102C00285000 (285 strike call) - $275 loss
2. AAPL260102C00280000 (280 strike call) - $330 gain

These two positions likely represent:
- **1 spread trade**: Short 285 call + Long 280 call (call credit spread)
- Net PnL: -$275 + $330 = +$55

### Our System
- Showing 5 closed trades (all have `broker_order_id_close`)
- Need to verify if these 5 trades actually correspond to Tradier positions

## Root Cause Hypothesis

1. **Date filtering issue**: Trades closed on different ET dates showing as same day
2. **Spread vs individual positions**: We track spreads, Tradier shows individual legs
3. **Multiple spread trades**: 5 different spread trades that don't all have closed positions today

## Action Required

1. **Verify each closed trade maps to Tradier positions**
2. **Ensure we're not tracking phantom trades**
3. **Match spread trades to individual option contracts in Tradier**
4. **Implement stricter validation**: Only track trades that have actual Tradier orders AND positions

## Philosophy Reminder

**Gekkoworks = Mirror of Tradier**
- Only track trades with actual broker orders
- Only count closed trades that match Tradier's closed positions
- No phantom trades - if Tradier doesn't show it, we shouldn't either

