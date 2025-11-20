Absolutely.
This is one of the most critical documents in the entire system, because **Proposal Generation is the gateway** — the choke point — that ensures:

* Only edge-positive trades ever reach execution
* No noise, no drift, no sloppiness enters the system
* Cursor has zero freedom to improvise
* The system remains disciplined, consistent, and safe

This file defines the EXACT pipeline, step-by-step, as if it were a machine protocol.

No interpretation.
No alternative flows.
Everything deterministic.

Let’s build a document worthy of a professional trading desk.

---

# 📘 `/docs/proposal-generation.md`

**SAS Proposal Generation v1.0**
**Status: Canonical System Specification (NON-OVERRIDABLE)**

This document defines **the exact mechanics** by which SAS generates trade proposals.
Every step in this process is mandatory, strictly ordered, and must be executed precisely as documented.

The Proposal Engine is responsible for:

1. Market data ingestion
2. Valid candidate construction
3. Sequential filtering
4. Scoring
5. Selecting the single highest-scoring candidate
6. Producing zero or one proposal per cycle

Cursor **cannot** alter or reorder steps.
This document is law.

---

# **1. Proposal Engine Purpose**

The purpose of Proposal Generation is to:

* Translate market data into structured trade candidates
* Apply strict filters to eliminate non-edge scenarios
* Compute full scoring and risk metrics
* Produce only the single best allowable trade
* Avoid overtrading, noise, FOMO, or randomness

Proposal generation is the **thinking node** of the SAS system.
Execution logic never overrides proposal logic.

---

# **2. Proposal Generation Pipeline (Top-Level Flow)**

The process is strictly sequential:

```
[1] Load Market State
[2] Validate Data Integrity
[3] Select Eligible Expirations (30–35 DTE)
[4] Build Raw Candidates (SPY bull put spreads)
[5] Apply Hard Filters (reject invalid)
[6] Compute Metrics (IVR, skew, delta, credit, EV)
[7] Apply Scoring Model
[8] Enforce Score Threshold
[9] Select Highest-Scoring Candidate
[10] Emit Proposal or Emit None
```

Cursor must follow this pipeline EXACTLY.

No parallelization.
No shortcuts.
No dynamic reordering.

---

# **3. Data Required for Proposal Generation**

Proposal generation cannot proceed unless ALL required data fields are available.

### **3.1 Underlying Market Data**

Required:

* SPY last price
* SPY bid/ask
* SPY IV (current)
* IV_min_52wk
* IV_max_52wk
* RV_30d (realized volatility)

Reject the entire run if ANY are missing.

---

### **3.2 Option Chain Data**

For each strike in each eligible expiry, the following fields are required:

**Mandatory:**

* bid
* ask
* delta
* implied_volatility
* strike_price
* expiration_date
* OCC symbol

Reject candidate if ANY field missing.

---

# **4. Expiration Selection Rules**

The engine must identify expirations satisfying:

```
30 ≤ DTE ≤ 35
```

Rules:

* If multiple expirations fit, include all.
* If none fit, emit **no proposal**.
* Never use expirations outside this range.

This window is fixed for v1.

---

# **5. Candidate Construction Rules**

For each eligible expiration:

### **5.1 Short Put Strike Selection**

Candidates generated from strikes with:

```
-0.25 ≥ delta_short ≥ -0.35
```

But delta range will later adjust based on skew (covered in Strategy Engine).

### **5.2 Long Put Strike Selection**

Long put must be exactly:

```
long_strike = short_strike - 5
```

If the chain does not contain this long strike → candidate rejected.

### **5.3 Spread Width**

Width is fixed:

```
width = 5
```

### **5.4 Credit Calculation**

Compute:

```
credit = bid_short_put - ask_long_put
```

Reject candidate if:

* credit ≤ 0
* either bid or ask is missing
* either bid or ask is 0 (signals no liquidity)

---

# **6. Hard Filters (Reject on Sight)**

These filters MUST be applied in order.
Any failure = candidate rejection.

---

## **6.1 RV/IV Requirement**

Required:

```
IV_30d / RV_30d ≥ 1.20
```

If false → reject all candidates for this cycle (no proposal).

---

## **6.2 IVR Requirement**

From 52-week IV range:

Reject if:

```
IVR < 0.20
IVR > 0.75
```

---

## **6.3 Liquidity Requirements**

For both short and long legs:

* bid/ask spread ≤ **$0.15**
* open interest ≥ **100**
* bid > 0
* ask > 0

Any fail → reject candidate.

---

## **6.4 Vertical Skew Requirement**

Compute:

```
vertical_skew = (IV_short - IV_long) / IV_short
```

Reject if:

* vertical_skew < 0
* vertical_skew > 0.50

---

## **6.5 Term Structure Requirement**

Compute:

```
term_structure = (front_IV - back_IV) / back_IV
```

Reject if:

```
term_structure < -0.05
```

---

## **6.6 Delta Fitness Requirement**

Short put delta must fall within skew-adjusted target delta band.

Specified in Strategy Engine doc.
Any failure → reject.

---

## **6.7 Credit Requirement (Dynamic Minimum)**

Minimum credit formula:

```
base = 0.20 * width
ivr_adjust = (IVR - 0.30) * 0.10 * width
skew_adjust = vertical_skew * 0.10 * width

min_credit = base + ivr_adjust + skew_adjust
min_credit = clamp(min_credit, 0.80, 2.00)
```

Reject if:

```
credit < min_credit
```

---

## **6.8 Expected Value Requirement**

EV computed using scoring model.

Reject if:

```
EV ≤ 0
```

---

# **7. Scoring Requirements**

All candidates that pass hard filters must be scored using the formulas defined in **`scoring-model.md`**.

This includes:

* IVR_score
* vertical_skew_score
* term_structure_score
* delta_fitness_score
* EV_score

Score must be computed EXACTLY as specified.

Reject if:

* ANY component missing
* ANY normalization skipped
* ANY score undefined

---

# **8. Proposal Selection Logic**

After scoring, follow EXACT logic:

### **8.1 Remove Low-Scoring Candidates**

Reject if:

```
composite_score < 0.70
```

### **8.2 Sort Remaining**

Sort by:

1. Highest composite score
2. If tied → highest EV
3. If tied → highest credit
4. If tied → nearest delta to target
5. If tied → lowest expected max loss

### **8.3 Select One**

Select the top candidate.

### **8.4 If None Survive**

Emit **no proposal**.

### **8.5 Proposal Format**

Proposal must include:

```
symbol
expiration
short_strike
long_strike
width
credit_target
delta_short
IV_short
IV_long
IVR
vertical_skew
term_structure
EV
POP
max_profit
max_loss
composite_score
full scoring breakdown
timestamp
```

Cursor must log ALL fields.

---

# **9. Data Integrity Safeguards**

### A proposal cannot be generated if:

* Bid or ask missing
* Delta missing
* IV missing
* RV missing
* Back-month IV missing
* RV/IV < 1.20
* Any math fails due to divide-by-zero
* Expiration is missing DTE
* Strike structure incomplete

If any error occurs → **proposal generation aborts with no proposal**.

---

# **10. Determinism Requirement**

Given identical market data inputs:

* The proposal must be the same EVERY time
* Scoring must be identical
* Filters must produce identical results
* Same candidate must be selected

Cursor must NOT introduce randomness, approximation, heuristics, or alternative scoring paths.

---

# **11. Logging Requirements**

Each proposal cycle must produce logs showing:

* Candidates built
* Candidates rejected and the exact rule violated
* All metrics for valid candidates
* Sorted scoring table
* Final chosen proposal or explicit “no proposal” message

This is mandatory for traceability.

---

# **12. Failure States and Required Behavior**

### **System failure → no proposal**

If the Proposal Engine encounters:

* Network errors
* API errors
* Missing fields
* Zero valid expirations
* Zero valid strikes
* Zero valid candidates
* Scoring calculation failures

It MUST emit **zero proposals**.

It must NEVER:

* Retry automatically
* “Guess” values
* Infer missing fields
* Select a partial candidate
* Bypass scoring
* Create a fallback strategy

---

# **END OF DOCUMENT**

This file defines the entire Proposal Generation pipeline.

Proposal generation is ONLY valid when:

* Data is complete
* Candidates are valid
* Scoring passes
* Threshold is hit

Otherwise → no proposal.

---

