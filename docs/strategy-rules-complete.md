# Gekkoworks Strategy Rules — Complete Specification

**Status**: Active Production Rules  
**Last Updated**: Current Implementation  
**Strategies**: BULL_PUT_CREDIT, BEAR_CALL_CREDIT

---

# Table of Contents

1. [Opening Rules — BULL_PUT_CREDIT](#1-opening-rules---bull-put-credit)
2. [Opening Rules — BEAR_CALL_CREDIT](#2-opening-rules---bear-call-credit)
3. [Shared Opening Requirements](#3-shared-opening-requirements)
4. [Closing Rules (Both Strategies)](#4-closing-rules-both-strategies)

---

# 1. Opening Rules — BULL_PUT_CREDIT

## 1.1 Strategy Structure

**Definition**: Sell a PUT at higher strike, buy a PUT at lower strike

```
Short PUT: Strike = S (higher strike, closer to ATM)
Long PUT:  Strike = S - 5 (lower strike, further OTM)
Width:     5 points (fixed)
```

**Direction**: Bullish-to-neutral (profit when underlying stays above short strike)

---

## 1.2 Candidate Construction

### 1.2.1 Strike Selection

**Short Put Delta Range**:
```
-0.32 ≤ delta_short ≤ -0.18
```

**Long Put Strike**:
```
long_strike = short_strike - 5
```

If no matching long strike exists → **candidate rejected**.

---

### 1.2.2 Credit Calculation

**Formula**:
```
credit = bid_short_put - ask_long_put
```

**Rejection Conditions**:
- `credit ≤ 0` → reject
- Missing `bid_short_put` → reject
- Missing `ask_long_put` → reject
- `bid_short_put = 0` or `ask_long_put = 0` → reject (no liquidity)

---

### 1.2.3 Risk/Reward Metrics

**Maximum Profit**:
```
max_profit = credit (per contract)
```

**Maximum Loss**:
```
max_loss = width - credit = 5 - credit (per contract)
```

**Example**: If `credit = $1.20`, then `max_profit = $1.20` and `max_loss = $3.80`

---

## 1.3 Hard Filters (Must Pass All)

### 1.3.1 DTE Window

```
30 ≤ DTE ≤ 35
```

Configurable via:
- `PROPOSAL_DTE_MIN = 30`
- `PROPOSAL_DTE_MAX = 35`

---

### 1.3.2 Minimum Credit (Dynamic)

**Base Formula**:
```
base_credit = 0.20 * width = 0.20 * 5 = $1.00
```

**Current Implementation**:
- Hard floor: `credit ≥ width * 0.16 = $0.80`
- Configurable via `MIN_CREDIT_FRACTION = 0.16` (16% of width)
- Lowered from 0.18 to allow more trades in calmer vol regimes

**Absolute Floor**:
```
credit ≥ $0.60 (per entry-rules.md)
```

---

### 1.3.3 IV Rank (IVR)

**Calculation**:
```
IVR = (IV_now - IV_min_52wk) / (IV_max_52wk - IV_min_52wk)
```

**Acceptance Windows**:
- **Reject if**: `IVR < 0.15` or `IVR > 0.70` (LIVE/DRY_RUN)
- **Optimal zone**: `0.30 ≤ IVR ≤ 0.60` → full score
- **Acceptable**: `0.20 ≤ IVR < 0.30` → reduced score
- **Acceptable**: `0.60 < IVR ≤ 0.75` → reduced score

---

### 1.3.4 Vertical Skew

**Calculation**:
```
vertical_skew = (IV_short - IV_long) / IV_short
```

**Rejection Conditions**:
- `vertical_skew < 0` → reject (inverted skew)
- `vertical_skew > 0.50` → reject (too extreme, tail risk)
- `|vertical_skew| > 2.0` → reject (outlier)

**Note**: Current implementation uses softer scoring, but hard filters remain.

---

### 1.3.5 RV/IV Ratio

**Requirement**:
```
IV_30d / RV_30d ≥ 1.20
```

**Meaning**: Implied volatility must exceed realized volatility by at least 20%

If false → **reject all candidates** for this cycle.

---

### 1.3.6 Probability of Profit (POP)

**Calculation**:
```
POP = 1 - |delta_short|
```

**Example**: If `delta_short = -0.28`, then `POP = 1 - 0.28 = 0.72` (72%)

**Hard Filter**:
```
POP ≥ 0.65
```

If `POP < 0.65` → **candidate rejected**.

---

### 1.3.7 Expected Value (EV) - NOT A HARD FILTER

**Calculation** (for informational purposes only):
```
POP = 1 - |delta_short|
max_profit = credit
max_loss = width - credit

EV = POP * max_profit - (1 - POP) * max_loss
```

**Example**:
```
credit = $1.20
delta_short = -0.28
POP = 1 - 0.28 = 0.72
max_profit = $1.20
max_loss = 5 - 1.20 = $3.80

EV = (0.72)(1.20) - (0.28)(3.80)
EV = 0.864 - 1.064 = -$0.20
```

**Important**: EV is **NOT** used as a hard filter. The simplified EV formula doesn't accurately represent credit spread outcomes (most losers are partial, not full max loss). EV may be computed for informational purposes but does NOT reject candidates.

---

### 1.3.8 Liquidity Requirements

**For Both Legs**:
```
bid > 0
ask > 0
bid < ask
bid/ask spread ≤ $0.15
```

**Percentage Spread** (for scoring):
```
short_pct_spread = (ask_short - bid_short) / bid_short
long_pct_spread = (ask_long - bid_long) / bid_long
```

If ANY leg fails → **candidate rejected**.

---

### 1.3.9 Term Structure

**Calculation**:
```
front_IV = IV on selected expiration (DTE 30-35)
back_IV = IV on next monthly expiration (DTE > selected)

term_structure = (front_IV - back_IV) / back_IV
```

**Rejection Condition**:
```
term_structure < -0.05
```

If term structure is too negative → **candidate rejected**.

---

## 1.4 Scoring Model

### 1.4.1 Component Weights (v2 Implementation)

| Component | Weight |
|-----------|--------|
| POP Score | 40% |
| Credit Quality | 25% |
| IVR Score | 20% |
| Delta Suitability | 8% |
| Liquidity | 4% |
| Skew | 3% |

**Total**: 100%

---

### 1.4.2 Component Scoring Formulas

#### POP Score (40% weight)

**Normalization**:
```
POP_clamped = clamp(POP, 0.5, 0.9)
POP_score = (POP_clamped - 0.5) / 0.4
```

**Range**: 0.0 → 1.0  
**Example**: `POP = 0.72` → `POP_score = (0.72 - 0.5) / 0.4 = 0.55`

---

#### Credit Quality Score (25% weight)

**Formula** (S-curve):
```
credit_fraction = credit / width
k = 15
x = credit_fraction - 0.22
credit_score = 1 / (1 + exp(-k * x))
```

**Example**: 
- `credit = $1.20`, `width = 5`
- `credit_fraction = 0.24`
- `x = 0.24 - 0.22 = 0.02`
- `credit_score = 1 / (1 + exp(-15 * 0.02)) = 1 / (1 + exp(-0.3)) ≈ 0.57`

---

#### IVR Score (20% weight)

**Formula**:
```
center = 0.45
distance = |IVR - center|
decay = 7.5
IVR_score = clamp(1 - distance * decay, 0, 1)
```

**Example**:
- `IVR = 0.44`
- `distance = |0.44 - 0.45| = 0.01`
- `IVR_score = 1 - 0.01 * 7.5 = 0.925`

---

#### Delta Suitability Score (8% weight)

**Formula**:
```
target_delta = 0.25 (absolute value)
tolerance = 0.07
abs_delta = |delta_short|

delta_score = clamp(1 - |abs_delta - target_delta| / tolerance, 0, 1)
```

**Example**:
- `delta_short = -0.28`
- `abs_delta = 0.28`
- `delta_score = 1 - |0.28 - 0.25| / 0.07 = 1 - 0.03/0.07 = 0.57`

---

#### Liquidity Score (4% weight)

**Formula**:
```
total_pct_spread = short_pct_spread + long_pct_spread
liquidity_score = clamp(1 - total_pct_spread * 12, 0, 1)
```

**Example**:
- `short_pct_spread = 0.02`, `long_pct_spread = 0.03`
- `total_pct_spread = 0.05`
- `liquidity_score = 1 - 0.05 * 12 = 0.40`

---

#### Skew Score (3% weight)

**Formula**:
```
abs_skew = |vertical_skew|

if abs_skew ≤ 0.10: skew_score = 1.0
elif abs_skew ≥ 0.50: skew_score = 0.0
else: skew_score = 1 - (abs_skew - 0.10) / 0.40
```

**Example**:
- `vertical_skew = 0.18`
- `abs_skew = 0.18`
- `skew_score = 1 - (0.18 - 0.10) / 0.40 = 1 - 0.20 = 0.80`

---

### 1.4.3 Composite Score

**Formula**:
```
composite_score = 
    (POP_score * 0.40) +
    (credit_score * 0.25) +
    (IVR_score * 0.20) +
    (delta_score * 0.08) +
    (liquidity_score * 0.04) +
    (skew_score * 0.03)
```

**Minimum Threshold**:
```
composite_score ≥ 0.95 (configured via PROPOSAL_MIN_SCORE)
```

Currently configured: **≥ 95** (on 0-100 scale, so ≥ 0.95 on 0-1 scale)

---

# 2. Opening Rules — BEAR_CALL_CREDIT

## 2.1 Strategy Structure

**Definition**: Sell a CALL at lower strike, buy a CALL at higher strike

```
Short CALL: Strike = S (lower strike, closer to ATM)
Long CALL:  Strike = S + 5 (higher strike, further OTM)
Width:      5 points (fixed)
```

**Direction**: Bearish-to-neutral (profit when underlying stays below short strike)

**Important**: Short strike must be **ABOVE** current underlying price (OTM)

---

## 2.2 Candidate Construction

### 2.2.1 Strike Selection

**Short Call Delta Range**:
```
0.20 ≤ delta_short ≤ 0.35
```

**Long Call Strike**:
```
long_strike = short_strike + 5
```

**OTM Requirement**:
```
short_strike > underlying_price
```

If `short_strike ≤ underlying_price` → **candidate rejected**.

---

### 2.2.2 Credit Calculation

**Formula**:
```
credit = bid_short_call - ask_long_call
```

**Rejection Conditions**: Same as BULL_PUT_CREDIT

---

### 2.2.3 Risk/Reward Metrics

**Maximum Profit**:
```
max_profit = credit (per contract)
```

**Maximum Loss**:
```
max_loss = width - credit = 5 - credit (per contract)
```

**Same formulas as BULL_PUT_CREDIT** (both are credit spreads)

---

## 2.3 Hard Filters (Same as BULL_PUT_CREDIT)

All filters from Section 1.3 apply:
- DTE window: 30-35 days
- Minimum credit: 18% of width ($0.90), absolute floor $0.60
- IVR: 0.15-0.70 (LIVE/DRY_RUN)
- Vertical skew: 0 to 0.50
- RV/IV ratio: ≥ 1.20
- POP: ≥ 0.65
- EV: > 0
- Liquidity: spreads ≤ $0.15
- Term structure: ≥ -0.05

---

## 2.4 Scoring Model

**Same as BULL_PUT_CREDIT** (Section 1.4)

**Note**: Delta suitability uses **positive delta** values for calls:
- `target_delta = 0.25`
- `0.20 ≤ delta_short ≤ 0.35` for acceptance

---

# 3. Shared Opening Requirements

## 3.1 Market Hours

```
9:30:00 AM ET ≤ time ≤ 3:50:00 PM ET
```

Reject if:
- Pre-market
- Post-market
- After 3:50 PM ET

---

## 3.2 Entry Validation (Just Before Order Placement)

### 3.2.1 Proposal Freshness

```
proposal_age ≤ 15 minutes
```

If `proposal_age > 15 minutes` → **reject and invalidate proposal**.

---

### 3.2.2 Credit Revalidation

**Recompute**:
```
live_credit = bid_short - ask_long
```

**Checks**:
```
live_credit ≥ proposal.min_credit
live_credit ≥ $0.60 (absolute floor)
```

If credit deteriorated → **cancel entry**.

---

### 3.2.3 Bid/Ask Revalidation

**For Both Legs**:
```
bid > 0
ask > 0
bid < ask
bid/ask spread ≤ $0.15
```

If ANY fail → **cancel entry**.

---

### 3.2.4 Spread Width Validation

**Verify**:
```
For BULL_PUT_CREDIT: short_strike - long_strike = 5
For BEAR_CALL_CREDIT: long_strike - short_strike = 5
```

If not exactly 5 → **reject proposal**.

---

### 3.2.5 Price Stability Requirement

**Requirement**:
```
|mid_price_now - mid_price_2min_ago| ≤ $0.05
```

Where:
```
mid_price = (bid + ask) / 2
```

If mid fluctuates more than $0.05 in 2 minutes → **no entry**.

---

### 3.2.6 Underlying Stability Requirement

**Requirement**:
```
|price_change_1min| ≤ 0.30%
```

Where:
```
price_change_1min = (price_now - price_1min_ago) / price_1min_ago
```

If SPY moves too fast → **skip trade**.

---

### 3.2.7 Risk Caps (NEW)

#### Per-Trade Max Loss

```
max_loss ≤ MAX_TRADE_LOSS_DOLLARS
```

Currently: `MAX_TRADE_LOSS_DOLLARS = 450`

If `max_loss > 450` → **reject**.

---

#### Daily New Risk Cap

```
sum(max_loss of trades opened today) + new_trade_max_loss ≤ DAILY_MAX_NEW_RISK
```

Currently: `DAILY_MAX_NEW_RISK = 1500`

If adding new trade would exceed $1,500 → **reject**.

---

#### Daily Realized Loss Cap

```
daily_realized_pnl > DAILY_MAX_LOSS
```

Currently: `DAILY_MAX_LOSS = -500`

If `daily_realized_pnl ≤ -$500` → **stop all new entries** (exit-only mode).

---

#### Underlying Concentration Cap

```
sum(max_loss of all OPEN trades for symbol) + new_trade_max_loss ≤ UNDERLYING_MAX_RISK
```

Currently: `UNDERLYING_MAX_RISK = 2000`

Example: If SPY already has $1,800 in open risk, new SPY trade with $300 max_loss → **reject** ($1,800 + $300 = $2,100 > $2,000)

---

#### Expiry Concentration Cap

```
sum(max_loss of all OPEN trades for (symbol, expiry)) + new_trade_max_loss ≤ EXPIRY_MAX_RISK
```

Currently: `EXPIRY_MAX_RISK = 1000`

Example: If SPY Dec-20 already has $800 in open risk, new SPY Dec-20 trade with $250 max_loss → **reject** ($800 + $250 = $1,050 > $1,000)

---

## 3.3 Entry Order Execution

### 3.3.1 Entry Limit Price

**Formula**:
```
entry_limit = credit_target - entry_slippage
entry_slippage = 0.02
```

**Example**: If `credit_target = $1.20`, then `entry_limit = $1.20 - $0.02 = $1.18`

---

### 3.3.2 Order Details

```
Type: LIMIT
Side: ENTRY (sell short, buy long)
Quantity: 1 spread (default, configurable)
Duration: DAY
Legs:
  - SELL_TO_OPEN short option (PUT for bull put, CALL for bear call)
  - BUY_TO_OPEN long option (PUT for bull put, CALL for bear call)
Tag: GEKKOWORKS-ENTRY
```

---

### 3.3.3 Fill Monitoring

```
Poll interval: 2 seconds
Timeout: 30 seconds total
```

If not filled within 30 seconds → **cancel order**, proposal marked `INVALIDATED`.

---

# 4. Closing Rules (Both Strategies)

## 4.1 Core Metrics

### 4.1.1 Mark Price Calculation

**For Both Strategies**:
```
mark_short = (bid_short + ask_short) / 2
mark_long = (bid_long + ask_long) / 2
current_mark = mark_short - mark_long
```

**Note**: For credit spreads, `current_mark` represents the **cost to close** the spread.

---

### 4.1.2 PnL Calculations

**Unrealized PnL**:
```
unrealized_pnl = entry_price - current_mark
```

**Maximum Profit**:
```
max_profit = entry_price (credit received)
```

**Maximum Loss**:
```
max_loss = width - entry_price
```

**Profit Fraction**:
```
profit_fraction = unrealized_pnl / max_profit
```

**Loss Fraction**:
```
loss_fraction = (-unrealized_pnl) / max_loss
```

If `unrealized_pnl ≥ 0`, then `loss_fraction = 0` (clamped).

---

## 4.2 Exit Trigger Priority Order

**MUST be evaluated in this exact order** (first match wins):

```
[1] EMERGENCY_EXIT (data/liquidity/market issues, structural breaks)
[2] PROFIT_TARGET
[3] STOP_LOSS
[4] TIME_EXIT
```

**Evaluation Rules**:
- EMERGENCY: Highest priority - triggers immediately on data/market/liquidity failures
- PROFIT_TARGET: Checked before STOP_LOSS to capture profits first
- STOP_LOSS: Checked after PROFIT_TARGET to prevent losses
- TIME_EXIT: Checked last to allow PnL-based exits to take precedence

**Note**: Optional exits like TRAIL_PROFIT and IV_CRUSH_EXIT, if enabled, would be placed between PROFIT_TARGET and STOP_LOSS, but are currently not in the primary evaluation path.

---

## 4.3 Exit Trigger #1: EMERGENCY_EXIT

### 4.3.1 Trigger Conditions

Trigger immediately if ANY of:

#### Data Integrity Failures
- `bid` missing or `= 0`
- `ask` missing or `= 0`
- Cannot compute `current_mark`
- `delta` missing
- `IV` missing
- Option leg disappears from chain
- Broker API errors

#### Market Dislocation
```
|underlying_change_15s| > 0.50%
```

#### Liquidity Collapse
```
bid/ask_spread > $0.30 for either leg
```

#### PnL Anomaly
```
|unrealized_pnl_change_10s| > 0.20 * max_profit
```

---

### 4.3.2 Execution

**Close Limit**:
```
If current_mark available:
    close_limit = current_mark + 0.02
Else:
    close_limit = width - entry_price + 0.20
```

**Timeout**: Submit within 1 second

---

## 4.4 Exit Trigger #2: PROFIT_TARGET

### 4.4.1 Trigger Condition

**Current Threshold** (simplified):
```
profit_fraction ≥ 0.50
```

**Explicit Formula**:
```
unrealized_pnl ≥ 0.50 * max_profit
```

Configurable via: `CLOSE_RULE_PROFIT_TARGET_FRACTION = 0.50`

---

### 4.4.2 Execution

**Close Limit**:
```
close_limit = current_mark + 0.02
```

**Retry Logic**:
- First attempt: `current_mark + 0.02`
- If not filled in 20 seconds → cancel, retry with `current_mark + 0.03`
- Maximum one retry

---

## 4.5 Exit Trigger #3: STOP_LOSS

### 4.5.1 Trigger Condition

**Current Threshold**:
```
loss_fraction ≥ 0.10
```

**Explicit Formula**:
```
(-unrealized_pnl) / max_loss ≥ 0.10
```

Or equivalently:
```
unrealized_pnl ≤ -0.10 * max_loss
```

Configurable via: `CLOSE_RULE_STOP_LOSS_FRACTION = 0.10`

**Important**: This is 10% of **max_loss**, NOT 10% of max_profit.

**Example**:
- `max_loss = $3.80`
- Trigger when: `unrealized_pnl ≤ -$0.38`
- Or: `loss_fraction ≥ 0.10`

---

### 4.5.2 Execution

**Close Limit**:
```
close_limit = current_mark + 0.02
```

If mark unstable → use:
```
close_limit = ask_short - bid_long + 0.05
```

If still unstable → **emergency close**.

---

## 4.6 Exit Trigger #4: TIME_EXIT

### 4.6.1 Trigger Condition

**DTE Threshold**:
```
DTE ≤ 2
```

**Time Cutoff**:
```
time ≥ "15:50" ET (3:50 PM)
```

Both conditions must be true:
```
DTE ≤ 2 AND time ≥ "15:50" ET
```

Configurable via:
- `CLOSE_RULE_TIME_EXIT_DTE = 2`
- `CLOSE_RULE_TIME_EXIT_CUTOFF = "15:50"`

---

### 4.6.2 Execution

**Close Limit**:
```
close_limit = current_mark + 0.02
```

If mark missing → **emergency exit logic**.

---

## 4.7 Close Order Mechanics

### 4.7.1 Order Details

```
Type: LIMIT
Side: EXIT (buy back short, sell back long)
Quantity: trade.quantity (from trade record)
Duration: DAY
Legs:
  - BUY_TO_CLOSE short option
  - SELL_TO_CLOSE long option
Tag: GEKKOWORKS-EXIT
```

---

### 4.7.2 Fill Monitoring

```
Poll interval: 2 seconds
Timeout: 20 seconds total
```

**Retry Logic**:
1. First attempt: `close_limit = current_mark + 0.02`
2. If not filled in 20 seconds → cancel
3. Recompute `current_mark`
4. Retry once: `close_limit_retry = current_mark + 0.03`
5. If retry fails → **emergency final close** at `width - entry_price + 0.20`

---

## 4.8 Trade Closure

### 4.8.1 When Fill Confirmed

**Update Trade Record**:
```
status = "CLOSED"
exit_price = avg_fill_price (from broker)
closed_at = fill_timestamp
realized_pnl = entry_price - exit_price
```

**Example**:
- `entry_price = $1.20`
- `exit_price = $0.50`
- `realized_pnl = $1.20 - $0.50 = $0.70` profit

---

### 4.8.2 PnL Validation

**For Credit Spreads**:
```
realized_pnl = entry_price - exit_price
```

**Ranges**:
- Best case: `realized_pnl = entry_price` (closed at $0.00, max profit)
- Worst case: `realized_pnl = -(width - entry_price)` (closed at full width, max loss)

**Example**:
- `entry_price = $1.20`, `width = 5`
- Best: `realized_pnl = $1.20`
- Worst: `realized_pnl = -$3.80`

---

# 5. Summary Tables

## 5.1 Opening Rules Summary

| Rule | BULL_PUT_CREDIT | BEAR_CALL_CREDIT |
|------|-----------------|------------------|
| Short Delta | -0.32 to -0.18 | +0.20 to +0.35 |
| Long Strike | `short - 5` | `short + 5` |
| Credit Formula | `bid_short_put - ask_long_put` | `bid_short_call - ask_long_call` |
| Max Profit | `credit` | `credit` |
| Max Loss | `5 - credit` | `5 - credit` |
| DTE Window | 30-35 days | 30-35 days |
| Min Credit | 16% of width ($0.80) | 16% of width ($0.80) |
| Min Score | 95 (0.95 on 0-1 scale) | 95 (0.95 on 0-1 scale) |
| OTM Required | No | Yes (short > underlying) |

---

## 5.2 Closing Rules Summary

| Trigger | Priority | Threshold | Config Key |
|---------|----------|-----------|------------|
| EMERGENCY | 1 | Data/market/liquidity failure | Various |
| PROFIT_TARGET | 2 | `profit_fraction ≥ 0.50` | `CLOSE_RULE_PROFIT_TARGET_FRACTION = 0.50` |
| STOP_LOSS | 3 | `loss_fraction ≥ 0.10` | `CLOSE_RULE_STOP_LOSS_FRACTION = 0.10` |
| TIME_EXIT | 4 | `DTE ≤ 2 AND time ≥ 15:50 ET` | `CLOSE_RULE_TIME_EXIT_DTE = 2` |

---

## 5.3 Risk Caps Summary

| Cap | Value | Purpose |
|-----|-------|---------|
| MAX_TRADE_LOSS_DOLLARS | 450 | Per-trade max loss limit |
| DAILY_MAX_NEW_RISK | 1500 | Daily new risk intake cap |
| DAILY_MAX_LOSS | -500 | Daily realized loss circuit breaker |
| UNDERLYING_MAX_RISK | 2000 | Max risk per symbol |
| EXPIRY_MAX_RISK | 1000 | Max risk per (symbol, expiry) |

---

# 6. Complete Math Reference

## 6.1 Opening Metrics

```
credit = bid_short - ask_long
max_profit = credit
max_loss = width - credit
POP = 1 - |delta_short|
EV = POP * max_profit - (1 - POP) * max_loss
```

## 6.2 Closing Metrics

```
current_mark = (bid_short + ask_short)/2 - (bid_long + ask_long)/2
unrealized_pnl = entry_price - current_mark
profit_fraction = unrealized_pnl / max_profit
loss_fraction = (-unrealized_pnl) / max_loss
```

## 6.3 Exit Thresholds

```
PROFIT_TARGET: profit_fraction ≥ 0.50
STOP_LOSS:     loss_fraction ≥ 0.10
TIME_EXIT:     DTE ≤ 2 AND time ≥ "15:50" ET
```

## 6.4 Final PnL

```
realized_pnl = entry_price - exit_price
```

---

**END OF SPECIFICATION**

This document defines the complete opening and closing rules for both strategies currently implemented in Gekkoworks.

