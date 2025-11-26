Perfect — the next document **must** be the one that prevents you from ever repeating the IBKR disaster.

We now write the definitive **Testing & Validation Bible**, the file that ensures *every part* of SAS is provably correct before you ever flip on auto-mode with real money.

This document becomes the checklist Cursor follows **before deploying**, **before enabling live trading**, and **after every change**.
This is how real quant shops operate.

Let's make it airtight.

---

# 📘 `/docs/testing-and-validation.md`

**SAS Testing & Validation Suite v1.0**
**Status: Canonical Pre-Launch & Continuous Validation Specification (NON-OVERRIDABLE)**

This document defines the **testing regimen** required before SAS is allowed to:

* Place proposals
* Place entry orders
* Monitor live trades
* Trigger exits
* Update risk state
* Connect to Tradier
* Run in auto-mode

This file acts as:

* A **launch checklist**
* A **post-deploy sanity suite**
* A **debugging trace map**
* A **Cursor implementation guardrail**

If a subsystem does not pass ALL required tests, SAS MUST NOT run.

---

# **1. Philosophy of Validation**

SAS is systemic:
One bad assumption → runaway losses.
One missing check → cascade failure.
One misunderstood broker behavior → $200k gone.

Therefore:

### **Validation is mandatory, continuous, and codified.**

Testing is not optional.
Cursor must reference this doc before implementing functionality.

This blueprint follows the same style used at actual quant/prop shops.

---

# **2. Validation Phases**

Validation is broken into six layers:

```
L0 – Environment Boot
L1 – Data Integrity
L2 – Core Engine Logic
L3 – Order Execution Logic
L4 – Monitoring & Exit Logic
L5 – Full Lifecycle Simulation
L6 – Risk Management Kill-Switch Testing
```

Each phase has pass/fail criteria.
If ANY phase fails → auto-trading disabled.

---

# **3. L0 — Environment Boot Validation**

Run at:

* First worker deploy
* After any code change
* Before market open daily (premarket cron)

### L0 Pass Criteria:

1. Worker boots without exceptions
2. Env vars present:

   * `TRADIER_API_TOKEN`
   * `TRADIER_ACCOUNT_ID`
   * `TRADIER_ENV`
3. D1 connection successful
4. `settings` table contains:

   * `MAX_TRADES_PER_DAY`
   * `MAX_DAILY_LOSS_PCT`
5. `risk_state` table contains:

   * `SYSTEM_MODE`
   * `LAST_HARD_STOP_AT`
   * `EMERGENCY_EXIT_COUNT_TODAY`

If any environment key is missing → **HARD_FAIL**.

---

# **4. L1 — Data Integrity Validation**

Before the system can trade, the following checks MUST pass:

### 4.1 Underlying Quote Check

* Fetch SPY quote
* Must contain non-null:

  * `bid`
  * `ask`
  * `last`

Validation rules:

* `bid ≥ 0`
* `ask ≥ bid`
* `last > 0`

Fail if:

* Any NaN
* Any null
* `ask - bid > 1.00` at open

---

### 4.2 Option Chain Integrity

For nearest DTE within 30–35:

* Retrieve chain
* Must contain ≥ 50 put contracts
* Every contract must have:

  * `bid`
  * `ask`
  * `type`
  * `strike`
  * `symbol`
  * `delta`
  * `implied_volatility`

Validation:

* `bid ≥ 0`
* `ask ≥ bid`
* `implied_volatility ∈ [0.01, 5.00]`
* `delta ∈ [-1, 0]` for puts

If missing Greeks → **INVALID_CHAIN**.

---

### 4.3 DTE sanity check

Calculate DTE:

```
0 ≤ DTE ≤ 365
```

If DTE < 0 → reject chain.
If DTE > 365 → something is broken in expiration handling.

---

If L1 fails → do not trade; set:

```
RISK_STATE = "DATA_FAILURE"
```

---

# **5. L2 — Core Engine Logic Validation**

This validates the pure modules:

* proposal-generation
* scoring
* metrics
* DTE
* skew
* IVR
* EV

These MUST behave deterministically.

### 5.1 Test Vectors (required)

Cursor must generate and include test vectors such as:

```
Input:
  bid_short = 1.20
  ask_long = 0.70
Expected credit = 0.50
```

or:

```
delta_short = -0.30
delta_optimal_target = -0.28
expected_delta_score = 0.90+
```

Every scoring component must have at least one static test vector.

---

### 5.2 Under Stress Tests

Simulated chain with:

* Extreme skew
* Missing vols
* Zero bid
* Tight markets
* Wide markets

The scoring model must:

* Never crash
* Never produce NaN
* Reject candidates instead of attempting to evaluate invalid legs

---

### 5.3 Determinism

Identical input chain MUST result in identical:

* Score
* Proposal selection
* Credit target
* Limit price

No randomness allowed.
No timing-dependent behavior.

---

# **6. L3 — Order Execution Logic Validation**

Now we test the **entry** system.

### 6.1 Limit Price Test

Given mid = 0.80:

```
limit_price = mid - 0.02 = 0.78
```

Given mid = 0.90:

```
limit_price = 0.88
```

Given mid = 0.62:

```
limit_price = 0.60 (but rejected if < min credit)
```

Cursor must assert these outcomes.

---

### 6.2 Entry Pendings

Simulate:

* Never-filling order
* Partially-filling (should never happen with multileg)
* Quick fill
* Slow fill
* Cancel behavior

Entry rules:

* Wait ≤ 20 seconds
* If no fill → cancel
* Never retry
* Never widen
* Never chase

A correct test suite MUST confirm these branches.

---

### 6.3 Broker Error Sim

Simulate:

* 500 error
* timeout
* strange response shape

System must:

* Mark entry as CANCELLED
* Never place a second attempt
* Return to idle
* No retry logic in v1

---

# **7. L4 — Monitoring & Exit Logic Validation**

Monitoring is the core of your risk system.
It must be bulletproof.

### 7.1 PnL Calculations

Given:

* Entry = $0.90 credit
* Mark = $0.60

```
pnl = entry - mark = 0.30
pnl_frac = pnl / entry = 0.333...
```

Cursor must confirm these math tests.

---

### 7.2 Exit Trigger Order

Verify that when multiple conditions are true simultaneously, exits follow priority:

```
1. Emergency
2. Stop-Loss
3. Profit Target
4. Time Exit
```

Test vector example:

```
pnl_frac = +0.50  (profit target)
bid collapsed = true (liquidity failure)
→ MUST trigger emergency exit
```

---

### 7.3 Time Exit

Check that when:

```
DTE ≤ 2
```

time exit triggers regardless of PnL.

---

### 7.4 Monitoring Frequency

System must poll every ~2 seconds.

Implement test that ensures:

* Monitoring cycle is at least that frequent
* Trade state updates propagate correctly between cycles

---

# **8. L5 — Full Lifecycle Simulation**

This is the most important part of this doc.

You must run a simulated environment through each stage of the lifecycle:

```
→ raw chain
→ proposal
→ entry pending
→ fill
→ monitoring
→ profit trigger
→ closing pending
→ fill
→ archive
→ risk updated
```

### These must all be validated:

* Database rows transition correctly
* Status fields transition correctly
* Timestamping is correct
* Risk counters increment correctly
* No ambiguous states
* No missing cleanup
* No zombie positions

A golden-path simulation must exist in test code.

---

### 8.1 Branch Simulations (also mandatory)

Cursor must simulate alternate branches:

* Entry rejected
* Proposal invalidated
* Entry canceled after timeout
* Exit stop-loss
* Exit emergency
* Exit time-based
* Exit fails on first attempt and succeeds on retry
* Exit fails twice and goes to HARD_STOP emergency close logic

These confirm state-machine integrity.

---

# **9. L6 — Risk Management Kill-Switch Testing**

Risk is the backbone of the new system.
It must be provably correct.

### 9.1 Daily Loss Limit

Simulate:

* Daily realized losses ≥ threshold
  System must:

* Trigger DAILY_STOP

* Block new trades

* Allow exits only

### 9.2 Emergency Exits

Simulate two emergency exits:

* System must trigger full kill-switch:

  * `SYSTEM_MODE = "HARD_STOP"`

Cursor must test the kill-switch manually AND with simulation.

---

### 9.3 Cooldown

Simulate:

* Daily stop triggered
* Next trading day → must reset RISK_STATE
* Ensure trading only resumes after reset

---

### 9.4 Broker Rate-Limit Failure

Simulate Tradier responding with 429 or rate-limit flag:

System must:

* Immediately attempt emergency exits
* Set RISK_STATE = "BROKER_RATE_LIMITED"
* Block entries for the rest of the day

---

### 9.5 Pre-Market Failure

Simulate:

* Pre-market health fails
  System must:

* Block entries all day

* Allow exits

* Log failure

---

# **10. Continuous Regression Testing**

Every time Cursor updates any:

* scoring logic
* proposal rules
* delta target
* width
* credit thresholds
* monitoring
* exit logic
* risk logic
* broker client behavior

SAS must run ALL tests again.

No changes merge without rerunning the suite.

---

# **11. Live-Dry-Run Mode (Mandatory Before Launch)**

Before enabling real auto-mode, system must run for **3 consecutive trading days** in:

```
DRY_RUN = "trade without placing"
```

System:

* Generates proposals
* Evaluates entries
* Evaluates exits
* Computes PnL
* Updates risk state

**But does NOT place real orders**.

Dry-run must produce:

* No fatal errors
* No monitoring gaps
* No risk violations
* Correct mark-to-market calculations
* Correct exit logic

After 3 clean days → eligible for live-paper mode.

---

# **12. Live-Paper Mode Validation (Mandatory Before Live Trading)**

Once DRY-RUN passes:

* Switch TRADIER_ENV to sandbox
* System places real sandbox trades
* Validate using real fills
* Check:

  * Entry pending behavior
  * Fill times
  * Exit fills
  * Broker edge cases
  * DB transitions
  * Risk enforcement

Must run **5 consecutive market days** with:

* No missing fills
* No ambiguous states
* No monitoring gaps
* No silent errors
* No invalid PnL
* No emergency kill-switch except during explicit simulation

After 5 perfect days → system eligible for real-money mode.

---

# **13. Manual Operator Checklist (Human Validation)**

Before turning on LIVE auto-mode:

Human must check:

1. Account funded
2. Correct `TRADIER_ACCOUNT_ID` used
3. Daily risk thresholds match account size
4. Worker logs clean
5. No zombie proposals
6. No zombie trades
7. No stale D1 state
8. Next cron cycle in range
9. `SYSTEM_MODE = "NORMAL"`

Human MUST confirm this before live mode.

---

# **14. Forbidden States in Validation**

Cursor must expressly test that the system **never** enters:

* `OPEN` without an entry fill
* `CLOSING_PENDING` without an exit trigger
* `CLOSED` with null fill fields
* `ENTRY_PENDING` beyond 20 seconds
* `CLOSING_PENDING` without broker-order-id
* Negative PnL due to incorrectly inverted credit/debit math
* Missing timestamps
* Missing risk transitions

If ANY forbidden state appears → auto-mode disabled.

---

# **15. Launch Criteria (Go/No-Go)**

System may GO LIVE only if:

| Layer           | Requirement                     | Status |
| --------------- | ------------------------------- | ------ |
| L0              | Boot Check Pass                 | ✔      |
| L1              | Data Integrity Pass             | ✔      |
| L2              | Metrics & Scoring Deterministic | ✔      |
| L3              | Entry Execution Correct         | ✔      |
| L4              | Monitoring + Exit Logic Perfect | ✔      |
| L5              | Full Lifecycle Sim Pass         | ✔      |
| L6              | Risk Kill-Switch Verified       | ✔      |
| Dry-Run         | 3 clean days                    | ✔      |
| Live-Paper      | 5 clean days                    | ✔      |
| Human Checklist | Signed off                      | ✔      |

Anything else → **NO GO**.

---

# **END OF DOCUMENT**

This is the strongest safety + correctness validation doc I can produce.
It forces Cursor and the system to prove correctness BEFORE risking even one dollar.

---
