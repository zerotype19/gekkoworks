Understood.
I’m going to create **the most precise, airtight, edge-based strategy specification you’ve ever seen** — the kind of document a quant PM would hand to execution engineers at a prop desk.

No fluff.
No ambiguity.
No wiggle room for Cursor.
No room for “interpretation.”

Everything binary.
Everything measurable.
Everything enforceable by code.

This becomes the **Strategy Engine Bible**.

---

# 📘 `/docs/strategy-engine.md`

**SAS Strategy Engine v1.0**
**Status: Canonical Specification (NON-OVERRIDABLE)**

This document defines the **strategic foundation** of the SAS trading system.
These rules govern which trades are allowed, how they are constructed, how they are scored, and under what conditions a proposal may be executed.

Nothing in this document is optional.
Nothing here may be softened, reinterpreted, or replaced without an explicit versioned update.

---

# **1. Purpose of the Strategy Engine**

The Strategy Engine exists to **evaluate market state**, **identify premium-selling situations where statistical edge exists**, and produce **high-quality, strictly-filtered proposals**.

A proposal is NOT a trade.
A proposal is a *candidate* that must pass all filters and meet the scoring threshold before execution.

The Strategy Engine must:

1. Gather underlying + option chain data
2. Compute all volatility and skew metrics
3. Filter out invalid or low-quality structures
4. Score every valid candidate
5. Output **exactly one** best proposal OR no proposal

This engine **cannot**:

* Create proposals that violate risk or volatility rules
* Create proposals based on intuition or incomplete data
* Produce more than one proposal per cycle
* Ever bypass scoring logic

---

# **2. Allowed Strategy Types**

For SAS v1, **only one strategy** is enabled:

## **Strategy: Bull Put Credit Spread (BPCS)**

Definition:
Sell a put at strike S, buy a put at strike S – W (width), forming a defined-risk credit spread.

Width (W):

* Fixed at **5 points** for SPY
* Future versions may support other widths, but not v1

Direction:

* **Always bullish-to-neutral**
* Selling premium during favorable volatility regimes

Market:

* SPY only (for v1)

---

# **3. Underlying Market Requirements**

The engine **must not** generate proposals unless all underlying conditions are met:

### **3.1 Realized vs Implied Volatility (RV/IV) Alignment**

Requirement:

```
IV_30d / RV_30d >= 1.20
```

Meaning:
Implied volatility must exceed realized volatility by **at least 20%**.

Purpose:
Ensures we are selling *inflated expectations*, not depressed ones.

If this fails → **no proposals allowed.**

---

### **3.2 IV Rank (IVR) Opportunity Window**

IVR must be computed on a 52-week range:

```
IVR = (IV_now - IV_min) / (IV_max - IV_min)
```

IVR cutoffs:

* **< 0.20 → Reject**
* **0.20–0.30 → Allowed but penalized score**
* **0.30–0.60 → Optimal zone (full score)**
* **0.60–0.75 → Acceptable but with risk penalty**
* **> 0.75 → Reject (too explosive)**

This is the backbone of the system’s edge.

---

### **3.3 Trend Filter**

SPY must NOT be in a confirmed downtrend.

Definition (v1 simple rule):

```
Close_price > 20-day EMA
```

If false → **no trade**.

This avoids selling puts in accelerating selloffs.

---

### **3.4 Liquidity Requirements**

For both short and long leg strikes:

* Bid/ask spread ≤ **$0.15**
* Open interest ≥ **100 contracts**
* Tradier must return both bid and ask; missing quotes = automatic reject

---

# **4. Option Candidate Construction**

The engine creates candidates based on:

### **4.1 DTE Window**

Only expirations with:

```
30 ≤ DTE ≤ 35
```

This window is chosen because:

* Theta is steep
* IV is usually elevated
* Assignment risk is low
* Gamma is moderate
* Spread pricing is stable

No exceptions.

---

### **4.2 Target Delta Range**

Short put delta must satisfy:

```
-0.25 ≥ delta_short ≥ -0.35
```

This range is adaptive based on skew:

* **If vertical skew is steep → shift toward -0.20**
* **If skew is flat → shift toward -0.35**

This mapping is defined in Section 6.

---

### **4.3 Spread Width**

Width = **5 points**
Long put strike = short strike – 5

If no matching long strike exists → candidate rejected.

---

### **4.4 Minimum Credit (Dynamic)**

The spread must collect at least:

```
min_credit = f(IVR, skew, delta)
```

Explicit formula:

```
base = 0.20 * width  
ivr_adjustment = (IVR - 0.30) * 0.10 * width   # ±10% of width
skew_adjustment = vertical_skew_score * 0.10 * width
min_credit = base + ivr_adjustment + skew_adjustment
```

Floor:

```
min_credit >= 0.80
```

Ceiling (never allow absurd min credit):

```
min_credit <= 2.00
```

If credit offered < min_credit → reject.

---

# **5. Skew Metrics**

Skew is the entire **edge engine** of SAS.

We measure:

## **5.1 Vertical Skew**

```
vertical_skew = (IV_short - IV_long) / IV_short
```

Invalid if:

* < 0 (inverted skew)
* > 0.50 (too extreme → tail risk)

Vertical skew scoring weight = **25% of composite score**

---

## **5.2 Term Structure (Horizontal Skew)**

Compute:

```
front_IV = IV on selected expiration  
back_IV = IV on next monthly expiration (DTE > selected)
term_structure = (front_IV - back_IV) / back_IV
```

Interpretation:

* Positive slope → front-month volatility elevated → favorable
* Negative slope → front-month deflated → avoid

Term structure contributes **15%** to composite score.

If term structure < -0.05 → reject.

---

# **6. Delta Fitness Adjustment**

Delta short is not static; skew affects placement:

Define:

```
if vertical_skew > 0.20 → shift_range = [-0.20, -0.30]
else if vertical_skew < 0.10 → shift_range = [-0.30, -0.40]
else shift_range = [-0.25, -0.35]
```

Candidates outside shift_range → rejected.

Delta fitness contributes **20%** of total score.

---

# **7. Expected Value Model (EV)**

EV must be positive.

Compute:

```
POP = 1 - |delta_short|
max_profit = credit
max_loss = width - credit

EV = POP * max_profit - (1 - POP) * max_loss
```

EV weight = **30%** of composite score.

If EV ≤ 0 → reject.

---

# **8. Composite Score Formula**

All candidates that survive filters are scored as:

```
score =
  (IVR_score * 0.20) +
  (vertical_skew_score * 0.25) +
  (term_structure_score * 0.15) +
  (delta_fitness_score * 0.20) +
  (EV_score * 0.20)
```

### Score normalization:

Each component must be scaled 0 → 1 *before* weighting.

### IVR Score:

```
if 0.30 ≤ IVR ≤ 0.60 → IVR_score = 1.0
elif 0.20 ≤ IVR < 0.30 → IVR_score = 0.5
elif 0.60 < IVR ≤ 0.75 → IVR_score = 0.7
else → reject
```

### Vertical Skew Score:

```
vertical_skew_score = clamp(vertical_skew / 0.30, 0, 1)
```

### Term Structure Score:

```
term_structure_score = clamp((term_structure + 0.05) / 0.10, 0, 1)
```

### Delta Fitness Score:

```
delta_fitness_score = 1 - (|delta_short - delta_center_of_shift| / 0.10)
```

### EV Score:

```
EV_score = clamp(EV / (width * 0.20), 0, 1)
```

---

# **9. Trading Threshold**

A proposal is allowed only if:

```
score >= 0.70
```

If no candidate scores ≥ 0.70 → **no trade**.

---

# **10. Proposal Output Requirements**

A valid proposal must include:

* symbol
* expiration date
* short strike
* long strike
* width
* credit_target
* full scoring breakdown
* all raw IV/skew metrics
* EV
* POP
* expected max profit / max loss
* timestamp

Cursor must log every component for transparency.

---

# **11. Failure Conditions — ZERO PROPOSALS**

The engine MUST output **no proposal** when:

* Any mandatory metric missing
* Bid/ask spreads exceed limits
* RV/IV ratio < 1.2
* IVR < 0.20 or > 0.75
* Vertical skew < 0 or > 0.50
* Front-month IV < back-month IV by > 5%
* Credit < dynamic minimum
* Delta outside allowed shift range
* EV ≤ 0
* Score < 0.70

No exceptions.
Ever.

---

# **12. Output Quantity**

**Exactly one** proposal per cycle:

* The highest scoring valid candidate
* OR none if no valid candidate exists

Never multiple.
Never random.
Never second choice.

---

# **END OF DOCUMENT**

This file defines the strategic brain of SAS.
Execution, scoring, monitoring, and exits all derive from these rules.

---
