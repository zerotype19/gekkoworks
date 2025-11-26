Perfect.
We’re moving into **the most important technical document** in the entire system — the *mathematical core* of the engine.

This is the file Cursor will reference constantly.
This file removes interpretation.
This file defines the exact calculations, expected ranges, weights, clamps, and behaviors.

This **is** the “quant brain.”

I’ll write it like something out of a hedge-fund internal spec — precise, austere, and code-ready.

---

# 📘 `/docs/scoring-model.md`

**SAS Scoring Model v1.0**
**Status: Canonical Mathematical Specification (NON-OVERRIDABLE)**

This document defines the **exact scoring formulas** used to evaluate option spread candidates. Every formula, threshold, weighting, normalization procedure, clamp, and fallback mechanism is explicitly defined.

Cursor MUST implement each formula exactly as written.
Cursor MUST NOT substitute alternate math, heuristics, or “improvements.”

This file is the authoritative source of truth for all scoring logic.

---

# **1. Purpose of the Scoring Model**

The scoring model exists to:

1. Quantify every candidate’s statistical quality
2. Normalize different metrics into comparable 0–1 ranges
3. Produce a single composite score
4. Reject candidates that fail minimum thresholds
5. Provide a deterministic, repeatable ranking system

Every candidate must produce a full scoring breakdown.

If any scoring component cannot be computed → **candidate rejected**.

---

# **2. High-Level Structure**

For each candidate:

```
IVR_score
vertical_skew_score
term_structure_score
delta_fitness_score
EV_score

Composite Score = Σ(component_score * component_weight)
```

Weights sum to **1.0**:

| Component            | Weight |
| -------------------- | ------ |
| IVR_score            | 0.20   |
| Vertical_skew_score  | 0.25   |
| Term_structure_score | 0.15   |
| Delta_fitness_score  | 0.20   |
| EV_score             | 0.20   |

Score output must be a **float between 0 and 1**.

Final threshold to trade:

```
Composite Score ≥ 0.70
```

Otherwise → **no proposal**.

---

# **3. Normalization Rules**

All raw metrics must be scaled to **0 → 1** range using:

```
normalized = clamp((value - min_range) / (max_range - min_range), 0, 1)
```

Clamping rule:

```
clamp(x, 0, 1) = max(0, min(1, x))
```

Cursor must apply clamping to ALL normalized scores.

---

# **4. Individual Component Definitions**

Below are the explicit formulas for each scoring element.

---

# **4.1 IVR Score (`IVR_score`)**

## **Input Definition**

```
IVR = (IV_now - IV_min_52wk) / (IV_max_52wk - IV_min_52wk)
```

If denominator = 0 → reject candidate.

## **Threshold Rules**

Reject if:

* IVR < 0.20
* IVR > 0.75

## **Scoring**

```
if 0.30 ≤ IVR ≤ 0.60 → IVR_score = 1.0
elif 0.20 ≤ IVR < 0.30 → IVR_score = 0.5
elif 0.60 < IVR ≤ 0.75 → IVR_score = 0.7
```

No other values allowed.

---

# **4.2 Vertical Skew Score (`vertical_skew_score`)**

## **Input Definition**

Let:

* `IV_short` = implied vol of short leg
* `IV_long` = implied vol of long leg

Compute:

```
vertical_skew = (IV_short - IV_long) / IV_short
```

## **Reject Conditions**

Reject if:

* vertical_skew < 0
* vertical_skew > 0.50  (too steep → tail risk)

## **Scoring**

Normalization range:
0 → 0.30

```
vertical_skew_score = clamp(vertical_skew / 0.30, 0, 1)
```

Examples:

* 0.00 → 0.00
* 0.15 → 0.50
* 0.30 → 1.00
* 0.40 → clamp(1.33) = 1.00

---

# **4.3 Term Structure Score (`term_structure_score`)**

## **Inputs**

* `front_IV` = IV of selected DTE
* `back_IV` = IV of next monthly expiration

```
term_structure = (front_IV - back_IV) / back_IV
```

## **Reject Conditions**

Reject if:

```
term_structure < -0.05
```

(Negative slope → unfavorable)

## **Scoring**

Normalization range:

```
-0.05 → +0.05
```

Shift and scale:

```
term_structure_score = clamp((term_structure + 0.05) / 0.10, 0, 1)
```

Examples:

* term_structure = -0.05 → 0
* term_structure = 0.00 → 0.50
* term_structure = +0.05 → 1
* term_structure = +0.10 → clamp(1.50) → 1

---

# **4.4 Delta Fitness Score (`delta_fitness_score`)**

## **Inputs**

* `delta_short` = absolute delta of short put
* Compute a **delta target center** based on vertical skew:

### Skew-adjusted delta target:

```
if vertical_skew > 0.20:
    target_delta = -0.25  # further OTM
elif vertical_skew < 0.10:
    target_delta = -0.35  # closer to ATM
else:
    target_delta = -0.30  # mid-range
```

## **Delta acceptance band**

Candidate must satisfy:

```
abs(delta_short - target_delta) ≤ 0.10
```

(Otherwise reject)

## **Scoring**

Distance penalty:

```
delta_fitness_score = 1 - (abs(delta_short - target_delta) / 0.10)
```

Clamp to [0,1].

Examples:

* exact match → 1.0
* off by 0.05 → 0.50
* off by 0.10 → 0.00

---

# **4.5 Expected Value Score (`EV_score`)**

## **Inputs**

```
POP = 1 - |delta_short|
max_profit = credit
max_loss = width - credit
EV = POP * max_profit - (1 - POP) * max_loss
```

## **Reject Conditions**

Reject if:

```
EV ≤ 0
```

## **Normalization Range**

We normalize EV relative to **width × 0.20**, meaning a spread that earns 20% EV of width is a perfect 1.0.

```
EV_score = clamp(EV / (width * 0.20), 0, 1)
```

Examples (width=5):

* EV = 1.0 → EV_score = 1
* EV = 0.5 → EV_score = 0.5
* EV = 0.2 → EV_score = 0.2
* EV negative → reject

---

# **5. Composite Score Calculation**

Combine all normalized components:

```
composite_score =
    (IVR_score              * 0.20) +
    (vertical_skew_score    * 0.25) +
    (term_structure_score   * 0.15) +
    (delta_fitness_score    * 0.20) +
    (EV_score               * 0.20)
```

All components MUST be present.

Missing any → reject candidate.

---

# **6. Score Threshold**

A trade is allowed ONLY if:

```
composite_score ≥ 0.70
```

Otherwise → **no proposal**.

Cursor must NEVER execute a trade below the threshold.

---

# **7. Additional Requirements**

## **7.1 Logging**

Each proposal must store:

* All raw inputs
* All intermediate metrics
* All normalized values
* Final composite score

Nothing can be hidden.

## **7.2 Determinism**

Same data → same score → same result.
No randomness.

## **7.3 No Interpolation**

Cursor may NOT “estimate” missing fields.
If Tradier does not return a field → candidate rejected.

---

# **8. Worked Example (Mandatory for Cursor QA)**

### Inputs:

* IVR = 0.44
* vertical_skew = 0.18
* term_structure = 0.03
* delta_short = -0.29
* credit = 1.20
* width = 5

### Compute:

#### IVR_score:

IVR in 0.30–0.60 → 1.0

#### vertical_skew_score:

0.18 / 0.30 = 0.60

#### term_structure_score:

(0.03 + 0.05) / 0.10 = 0.80

#### delta_fitness_score:

target_delta (skew 0.18) → -0.30
abs(-0.29 - -0.30) = 0.01
delta_fitness_score = 1 - (0.01/0.10) = 0.90

#### EV_score:

POP = 1 - 0.29 = 0.71
max_profit = 1.20
max_loss = 5 - 1.20 = 3.80

EV = (0.71)(1.20) - (0.29)(3.80)
EV = 0.852 - 1.102 = -0.25 → **reject**

Because EV ≤ 0 → candidate FAILS.

### Result:

**Candidate rejected before composite scoring.**

Correct.

---

# **END OF DOCUMENT**

This document defines the full mathematical scoring model for SAS.
All strategy behavior ultimately depends on this.

---

