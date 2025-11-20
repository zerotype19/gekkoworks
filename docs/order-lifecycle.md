Understood. This is the **flow doc**, the *master play-by-play*, the “one doc to rule them all” describing EXACTLY how a single SAS trade flows through the system from start to finish.

This document is not conceptual.
It is *procedural*.
Cursor will use it as the **execution map**, the **debugging guide**, and the **truth source** for every state transition.

Let’s build something worthy of a quant firm.

---

# 📘 `/docs/order-lifecycle.md`

**SAS Order Lifecycle v1.0**
**Status: Canonical Sequential Process Specification (NON-OVERRIDABLE)**

This document describes the **complete, end-to-end lifecycle of a SAS option spread**, from zero exposure to proposal, entry, monitoring, exit, and archival.

It combines all other Bible documents into one sequential timeline.

Cursor MUST follow this flow EXACTLY.
Any divergence introduces systemic risk.
Implementation must reflect this narrative step-for-step.

---

# **1. Overview**

Every SAS trade follows the same lifecycle:

```
[0] No Position
 →
[1] Proposal Generation
 →
[2] Proposal Validation
 →
[3] Entry Attempt
 →
[4] Entry Pending (Order Live)
 →
[5] Entry Fill → Trade Opens
 →
[6] Monitoring Loop
 →
[7] Exit Trigger Fires
 →
[8] Exit Pending (Closing Order Live)
 →
[9] Exit Fill → Trade Closed
 →
[10] Archive / PnL Accounting
```

This lifecycle must never skip or reorder steps.

---

# **2. Stage 0 — No Position (System Idle)**

The system begins a cycle only if:

* No OPEN or CLOSING_PENDING trades
* Risk gates allow trading
* Daily limits not hit
* Pre-market check passed
* System not in HARD_STOP
* Monitoring has no leftover stale state

If ANY of these fail → skip trading, do NOT generate a proposal.

System is "idle but ready."

---

# **3. Stage 1 — Proposal Generation**

Triggered by **`cron/tradeCycle`** during valid market hours.

### 3.1 Gather data

Retrieve from Tradier:

1. SPY underlying quote
2. IV, RV data (local calculation)
3. Option chain(s) for all expirations with DTE 30–35
4. Greeks for each strike within the chain

If ANY required data is missing → **abort proposal generation**.

---

### 3.2 Build raw candidates

For each expiration:

* Select short put legs within raw delta window (-0.25 to -0.35)
* Match long leg = short_strike - 5
* Compute preliminary credit = bid_short - ask_long
* Reject legs with bad liquidity or missing fields

Raw candidate is a pure data object.

---

### 3.3 Apply hard filters

Each candidate must pass ALL filters:

* RV/IV ratio
* IVR window
* Vertical skew
* Term structure
* Delta fitness
* Credit >= dynamic minimum
* Liquidity
* EV > 0

Any failure → candidate rejected.

---

### 3.4 Score all surviving candidates

Score using exact formulas in `scoring-model.md`.

Candidates with composite score < 0.70 → removed.

---

### 3.5 Select best candidate

If ≥1 candidate survives:

* Sort by:

  * highest score
  * then highest EV
  * then highest credit

Return the **single best**.

If no candidates survive → emit **no proposal**.

---

### 3.6 Persist proposal

Write row into D1:

```
proposal_id
symbol
expiration
short_strike
long_strike
width
credit_target
scoring breakdown
timestamp_created
status = "READY"
```

Now we enter Stage 2.

---

# **4. Stage 2 — Proposal Validation (Just Before Entry)**

When entry is attempted:

### Validation Checklist:

* Proposal age <= 15 minutes
* Market hours valid
* No trade opened today
* No trade currently OPEN or PENDING
* Risk gates allow new entries
* DTE still 30–35
* Recompute live credit; must meet min credit
* Check underlying stability
* Check mid-price stability
* Check liquidity again
* Check slippage bounds
* No recent emergency exit or kill-switch locks

If ANY fail → **proposal invalidated** and no trade placed.

Proposal marked `INVALID`.

Lifecycle stops; return to Stage 0 on next cycle.

---

# **5. Stage 3 — Entry Attempt**

If validation passes:

### 5.1 Compute entry limit price

Using formula in `execution.md`:

```
mid = computed credit mid
limit_price = mid - 0.02
```

Must satisfy:

```
0.60 ≤ limit_price ≤ 3.00
```

### 5.2 Submit multileg order

Call Tradier:

* sell_to_open short put
* buy_to_open long put
* quantity = 1
* type = limit
* price = limit_price

Persist:

```
trade_id (generated UUID)
proposal_id
broker_order_id_open
status = "ENTRY_PENDING"
timestamp_entry_submitted
```

Now move to Stage 4.

---

# **6. Stage 4 — ENTRY_PENDING (Waiting for Fill)**

Handled by `cron/monitorCycle`.

Every 2 seconds:

### 6.1 Poll order status from Tradier

If status:

* **OPEN / LIVE** → continue waiting
* **FILLED** → transition to OPEN
* **CANCELLED/REJECTED** → mark trade CANCELLED and return to Stage 0

Timeout:

If > 20 seconds with no fill:

* Send cancel request
* Confirm cancellation
* Set trade to CANCELLED
* End lifecycle
* Return to Stage 0 next cycle

NEVER retry entry.
NEVER widen entry price.

---

# **7. Stage 5 — Entry Fill → Trade Becomes OPEN**

Upon confirmed fill:

### 7.1 Persist fill details

```
entry_price = avg_fill_price
opened_at = timestamp
status = "OPEN"
max_profit = entry_price
max_loss = width - entry_price
```

### 7.2 Begin monitoring

Trade enters active state → Stage 6.

---

# **8. Stage 6 — Monitoring Loop (Every 2 Seconds)**

The Monitoring Engine calculates:

* current_mark
* unrealized_pnl
* pnl_fraction
* loss_fraction
* DTE
* liquidity
* volatility spikes
* data integrity

Then checks **exit triggers in priority order**:

```
1. Emergency Exit
2. Stop Loss Exit
3. Profit Target Exit
4. Time Exit (DTE ≤ 2)
```

If NO exit triggers → continue monitoring.

If exit trigger fires → go to Stage 7.

---

# **9. Stage 7 — Exit Trigger Fires**

Trade transitions:

```
status = "CLOSING_PENDING"
exit_reason = {profit, stop_loss, time, emergency}
timestamp_exit_triggered
```

Monitoring stops evaluating further triggers and hands control to Exit Engine.

Now we enter Stage 8.

---

# **10. Stage 8 — Exit Pending (Closing Order Live)**

The Exit Engine:

### 10.1 Computes close limit

Always a **limit order to buy back the spread**.

Formula depends on exit type, always:

```
close_limit = current_mark + slippage
slippage ∈ {0.02, 0.03}
```

For emergency close:

```
if mark missing:
    close_limit_final = width - entry_price + 0.20
```

### 10.2 Sends multileg close order:

* buy_to_close short put
* sell_to_close long put
* quantity = 1
* type = limit
* price = close_limit

Persist:

```
broker_order_id_close
timestamp_exit_submitted
```

### 10.3 Fill monitoring

Poll Tradier every 2 seconds:

* If **FILLED** → move to Stage 9
* If **CANCELLED** → try ONE retry
* If retry also fails → EMERGENCY FINAL CLOSE

---

# **11. Stage 9 — Exit Fill → Trade Closed**

Upon fill:

### 11.1 Save final details

```
exit_price = avg_fill_price
closed_at = timestamp
realized_pnl = entry_price - exit_price
status = "CLOSED"
```

### 11.2 Risk integration

Call `risk.recordTradeClosed`:

* Update daily realized PnL
* Update kill-switch counters
* Apply daily limits
* Possibly enter cooldown or HARD_STOP

### 11.3 Clean up

Remove any monitoring state and mark trade lifecycle fully completed.

Now proceed to Stage 10.

---

# **12. Stage 10 — Archive & Post-Processing**

After closure:

* Trade row is immutable except for audit fields
* Monitoring stops (no active position)
* Proposal engine can resume generating new proposals next cycle
* Web dashboard can query closed trade history
* Risk state updates control future ability to trade

System returns to Stage 0.

---

# **13. Full Lifecycle Summary (Condensed)**

```
[0] No Position
   ↓
[1] Proposal Generation (raw → filtered → scored → best)
   ↓
[2] Proposal Validation (fresh, stable, risk ok)
   ↓
[3] Entry Attempt (submit limit order)
   ↓
[4] ENTRY_PENDING (wait ≤ 20 seconds)
   ↓  (filled)
[5] OPEN (trade live)
   ↓  (monitor every 2 seconds)
[6] Monitoring Loop (PnL, volatility, liquidity, data)
   ↓  (trigger)
[7] Exit Trigger (profit/stop/time/emergency)
   ↓
[8] CLOSING_PENDING (closing order active)
   ↓  (filled)
[9] CLOSED (record PnL)
   ↓
[10] Archive & Risk Updates
   ↓
Back to [0] — next cycle
```

Every transition is deterministic and controlled by the rules in:

* Core Philosophy
* Strategy Engine
* Scoring Model
* Proposal Generation
* Entry Rules
* Execution Rules
* Monitoring
* Exit Rules
* Risk Management
* Broker Rules
* Architecture

Together they form SAS.

---

# **END OF DOCUMENT**

This is the lifecycle document that binds the entire SAS machinery together with no ambiguity.

