I’m choosing the next document **deliberately and strategically**:

# ✅ We do **`/docs/monitoring.md`** next.

Why?

Because Monitoring is the *bridge* between Entry and Exit —
and without a perfect monitoring engine, even flawless exit rules will fail.

Monitoring is the heartbeat.
It is the system’s nervous system.
If Monitoring is sloppy, slow, inconsistent, or ambiguous:

* Signals fire late
* Losses exceed limits
* Profits evaporate
* Emergency exits fail
* Positions get abandoned
* The system dies

This is where your previous system failed.
This is where sloppy implementations lose millions on real desks.
This document *must* be perfect.

And it will be.

---

# 📘 `/docs/monitoring.md`

**SAS Monitoring Loop v1.0**
**Status: Canonical Specification (NON-OVERRIDABLE)**

This document defines the exact behavior of the SAS Monitoring Engine.

The Monitoring Engine is responsible for:

* Reading live market data
* Updating PnL
* Detecting instability
* Enforcing exit conditions
* Protecting capital
* Operating continuously every 1 minute during market hours

Monitoring is the “always-on” component that keeps SAS safe.

Cursor MUST implement this EXACTLY.

---

# **1. Purpose of the Monitoring Engine**

The Monitoring Engine exists to:

* Observe all OPEN positions in real time
* Calculate all risk metrics
* Detect dangerous conditions
* Trigger exits in the correct priority order
* Maintain precise records
* Provide continuous situational awareness
* Prevent catastrophic drawdowns

Monitoring is not optional.
Monitoring does not sleep.
Monitoring does not skip cycles.

It runs every **1 minute** during market hours until all positions are closed.

---

# **2. Monitoring Frequency**

The monitoring loop runs:

```
every 1 minute during market hours, without fail
```

Requirements:

* No drifting intervals
* No batching
* No coalescing cycles
* No reordering
* No “run later” behavior

Each cycle is independent and mandatory.

---

# **3. Monitoring Inputs**

At each cycle, the following values MUST be retrieved live:

### **3.1 Underlying**

* SPY last price
* SPY 1-minute change
* SPY 15-second change
* SPY IV (for EV recalculation)

### **3.2 Short Put (leg 1)**

* bid_short
* ask_short
* delta_short
* IV_short

### **3.3 Long Put (leg 2)**

* bid_long
* ask_long
* delta_long
* IV_long

### **3.4 Time Data**

* current timestamp
* updated DTE

If ANY of these values are missing → **Emergency Exit**.

---

# **4. Mark Price Calculation**

At each monitoring interval:

```
mark_short = (bid_short + ask_short) / 2
mark_long  = (bid_long  + ask_long)  / 2

current_mark = mark_short - mark_long
```

If mark cannot be computed reliably (any bid/ask missing or zero) → **Emergency Exit**.

---

# **5. PnL Calculation**

```
unrealized_pnl = entry_credit - current_mark
max_profit = entry_credit
max_loss   = width - entry_credit

pnl_fraction  = unrealized_pnl / max_profit
loss_fraction = (current_mark - entry_credit) / max_loss
```

If ANY division-by-zero or NaN → **Emergency Exit**.

---

# **6. Instability Detection (Critical)**

Monitoring must detect:

### **6.1 Underlying Volatility Spikes**

If SPY moves:

```
> 0.30% in last 60 seconds → pause profit exits, allow only stop-loss or emergency exits
> 0.50% in last 15 seconds → Emergency Exit
```

### **6.2 Liquidity Collapse**

If bid/ask spread of either leg:

```
> $0.30 → Emergency Exit
```

### **6.3 Quote Disappearance**

If any bid/ask suddenly becomes 0 or missing → Emergency Exit.

---

# **7. Exit Trigger Evaluation Order**

Monitoring MUST evaluate exit conditions in this EXACT order:

```
[1] Emergency Exit
[2] Stop Loss
[3] Profit Target
[4] Time Exit
```

Cursor MUST NOT reorder or skip.

---

# **8. Emergency Exit Conditions**

Monitoring must trigger an **immediate emergency exit** if:

* Missing or zero bid/ask
* Missing delta values
* Missing volatility data
* Missing expiration or DTE
* Tradier errors
* JSON errors
* Mark cannot be computed
* Liquidity collapse
* Underlying spike > 0.50% in 15 seconds
* Mark moves > 20% of max_profit in 10 seconds

Monitoring MUST treat ANY data instability as an emergency.

---

# **9. Stop Loss Exit Triggering**

Stop loss is triggered when:

```
loss_fraction ≥ 0.60
```

This includes:

* Mark-based loss
* EV inversion
* Rapid mark deterioration

Once triggered → immediate transition to CLOSING_PENDING.

---

# **10. Profit Target Exit Triggering**

Trigger when:

```
pnl_fraction ≥ 0.40
```

Profit target **must execute instantly**, unless:

* underlying spike is occurring
* liquidity collapsed
* price integrity invalid

In those special cases → skip profit exit and re-evaluate next cycle.

---

# **11. Time-Based Exit**

Monitoring must trigger time-exit when:

```
DTE ≤ 2
```

Regardless of PnL.

---

# **12. Monitoring State Machine**

Monitoring operates under this state model:

```
ENTRY_PENDING → OPEN → CLOSING_PENDING → CLOSED
                    ↑
             MONITORING LOOP (2s)
```

State rules:

* MONITORING applies ONLY to OPEN positions
* EXIT rules transition OPEN → CLOSING_PENDING
* Execution engine handles CLOSING_PENDING → CLOSED

---

# **13. Monitoring After Exit Trigger**

When Monitoring detects an exit trigger:

1. Immediately freeze new exit checks
2. Stop evaluating profit/stop/time logic
3. Set trade state to `CLOSING_PENDING`
4. Pass control to Execution Engine
5. Continue monitoring until closure

The monitoring loop NEVER stops until trade closes.

---

# **14. Forbidden Monitoring Behaviors**

Cursor must NEVER:

* Skip a monitoring tick
* Merge ticks
* Delay evaluation
* Wait for additional data
* Smooth PnL
* Use averages instead of marks
* Allow undefined values to persist
* Wait for “better exit conditions”
* Perform discretionary holds
* Override priority order
* Apply machine learning or heuristics
* Use stale data
* Retry missing quotes
* Guess at missing values

These behaviors can destroy the system and are forbidden.

---

# **15. Logging Requirements**

Every monitoring cycle must log:

* SPY price & % change
* bid/ask for each leg
* current_mark
* unrealized_pnl
* pnl_fraction
* loss_fraction
* IV/IVR/term structure if computed
* DTE
* Detected instability flags
* Triggered exit state (if any)
* Emergency exit details

Logs must be complete enough to reproduce the trade history exactly.

---

# **16. Monitoring Failure State**

If Monitoring encounters a system error:

* Record failure
* Trigger Emergency Exit
* Continue monitoring until trade fully closed
* Raise a global error flag
* Prevent new entries until self-test passes

Monitoring must fail **safe**, not fail **silent**.

---

# **END OF DOCUMENT**

This is the heartbeat of the system.
This ensures the exits fire ON TIME, WITHOUT HESITATION, EVERY TIME.

---

