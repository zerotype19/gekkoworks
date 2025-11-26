Absolutely — this is the most **dangerous**, most **sensitive**, and most **capital-critical** component in the entire SAS system.

Entries determine opportunity.
**Exits determine survival.**

The last system blew up because exit rules were vague, late, or ambiguous.

This one **will not be.**
This document is written with **combat-level precision** — the way a prop firm documents liquidation procedures for 8-figure positions.

No interpretation.
No discretion.
No hope.

Let’s build it.

---

# 📘 `/docs/exit-rules.md`

**SAS Exit Rules v1.0**
**Status: Canonical Specification (NON-OVERRIDABLE)**

This document defines the exact and complete rules that determine when SAS must **close a position** and how that closing operation must be executed.

These rules override ALL other logic.
These rules are **life-or-death** for the system.
Cursor MUST implement them EXACTLY as written.

---

# **1. Purpose of Exit Rules**

The Exit Engine exists to:

1. Capture profits at the statistically optimal moment
2. Cut losses *before* they become catastrophic
3. Enforce time-based liquidation
4. Perform emergency exits when data, market structure, or broker state becomes unsafe
5. Avoid emotional, discretionary, or delayed exits
6. React within seconds to changes in conditions

The Exit Rules protect capital above all else.

---

# **2. Exit Monitoring Frequency**

Exit conditions must be checked **every 2 seconds** for all OPEN positions.

Monitoring must begin **immediately after fill confirmation**.

Cursor must:

* Never pause
* Never throttle
* Never wait for manual confirmation
* Never skip a scheduled monitoring cycle

Monitoring does not stop until position is fully closed.

---

# **3. Exit Triggers (Priority-Ordered)**

Exit triggers follow a strict priority hierarchy:

```
[1] Emergency Exit
[2] Stop Loss Exit
[3] Profit Target Exit
[4] Time-Based Exit
```

If multiple conditions are true simultaneously → the **highest-priority** exit rules.

Cursor MUST evaluate them in this order.

Illegal behaviors:

* Reordering checks
* Running them in parallel
* Prioritizing profit over risk
* Deferring emergency exits

---

# **4. Definitions and Data Requirements**

For each open spread:

```
entry_price        (credit received)
width              (5 for v1)
current_mark       (midpoint of remaining value)
max_profit         = entry_price
max_loss           = width - entry_price
unrealized_pnl     = entry_price - current_mark
pnl_fraction       = unrealized_pnl / max_profit
loss_fraction      = (max_loss - unrealized_pnl) / max_loss
```

If ANY of the above cannot be computed due to:

* Missing quotes
* Missing greeks
* Missing bid/ask
* Data corruption
* Broker API errors

→ Trigger **Emergency Exit** immediately.

---

# **5. Emergency Exit (Priority 1)**

Emergency exits override all other logic.

Emergency exit must be triggered if ANY of the following occur:

### **5.1 Missing or corrupt data**

If:

* bid or ask missing
* bid or ask = 0
* mark cannot be computed
* delta missing
* IV missing
* term structure missing
* long or short leg disappears from chain
* unexpected broker state

→ **Immediate emergency exit.**

---

### **5.2 Market dislocation**

If SPY moves:

```
> 0.50% within 15 seconds
```

→ Market is unstable → **emergency exit**.

---

### **5.3 Liquidity collapse**

If bid/ask spreads widen:

```
> $0.30 for either leg
```

→ **exit now**.

---

### **5.4 API or system instability**

If we encounter:

* Tradier API errors
* Timeouts > 1 second
* Multiple polling failures
* JSON parsing failures
* D1 write failures

→ Immediate exit attempt.

---

### **5.5 PnL anomaly**

If unrealized PnL suddenly changes by:

```
> 20% of max profit within 10 seconds
```

→ Possible volatility spike → exit.

---

### **Emergency Exit Execution**

Place a **limit close order**:

```
close_limit = current_mark + 0.02   # for debit to close
```

OR if current_mark cannot be computed:

```
close_limit = width - entry_price + 0.20   # auto-protective worst-case limit
```

Submit within **1 second**, same cancel/timeout rules as entry.

---

# **6. Stop Loss Exit (Priority 2)**

Stop Loss must be triggered when:

```
loss_fraction ≥ 0.60
```

Explicit Definition:

```
(current_mark - entry_price) ≥ 0.60 * max_loss
```

Or equivalently:

```
unrealized_pnl ≤ -0.60 * max_profit
```

Stop loss must trigger **immediately**, no waiting.

### **Stop Loss Execution Price**

```
close_limit = current_mark + 0.02
```

If mark unstable → use:

```
close_limit = ask_short - bid_long + 0.05
```

If still unstable → emergency close.

---

# **7. Profit Target Exit (Priority 3)**

Trigger when:

```
pnl_fraction ≥ 0.40
```

That is:

```
unrealized_pnl ≥ 0.40 * max_profit
```

### **Profit Exit Execution Price**

```
close_limit = current_mark + 0.02
```

Profit exits MUST NOT:

* Wait for even better prices
* Try to “hold longer”
* Stack multiple profit targets
* Act slowly

Profit target must trigger immediately when threshold is reached.

---

# **8. Time-Based Exit (Priority 4)**

Time-based exit MUST trigger at:

```
DTE ≤ 2
```

Regardless of:

* PnL
* Trend
* Volatility
* Skew
* Probability
* Score

Once expiration is 2 days away:
→ **the position must be closed**.

### **Time Exit Execution Price**

```
close_limit = current_mark + 0.02
```

If mark missing → emergency exit logic.

---

# **9. Limit-Order Close Mechanics**

Every close order must follow:

```
type = limit
limit_price = close_limit   # defined in relevant section
legs = buy_to_close short, sell_to_close long
duration = day
max_fill_time = 20 seconds
poll_interval = 2 seconds
```

If not filled by 20 seconds:

1. Cancel order
2. Immediately compute new mark
3. Reattempt ONE final time with:

```
close_limit_retry = current_mark + 0.03
```

Retry only once.

If second attempt fails:

* Mark as `CLOSE_FAILED`
* Trigger **emergency exit**
* Send final protective close at:

```
close_limit_final = width - entry_price + 0.20
```

---

# **10. Forbidden Exit Behaviors**

Cursor must NEVER:

* Use market orders
* Widen close prices beyond allowed retry logic
* Try to capture more profit than defined
* Override priority order
* Skip stop-loss checks
* Delay exits
* Wait for “better fills”
* Retry more than once
* Ignore missing data
* Smooth or average marks
* Infer prices
* Change thresholds
* Change percentages
* Disable emergency exit

ANY of these behaviors immediately invalidate system integrity.

---

# **11. State Transitions**

**OPEN → CLOSING_PENDING**

* triggered by exit logic
* cancel entry monitoring
* begin close monitoring

**CLOSING_PENDING → CLOSED**

* when final fill confirmed

**CLOSING_PENDING → CLOSE_FAILED**

* when all attempts exhausted
* escalate to emergency exit
* then CLOSED

**OPEN → EMERGENCY_EXIT**

* emergency rule triggered
* system bypasses normal path

**EMERGENCY_EXIT → CLOSED**

* once protective fill confirmed

No other states are allowed.

---

# **12. Logging Requirements**

Every exit must log:

* Trigger type
* Timestamp
* All inputs
* All computed metrics
* Computed limit prices
* Order submission confirmations
* Fill reports
* Cancel confirmations
* Emergency actions (if any)
* Final realized PnL

Logs must be detailed enough to reconstruct the entire trade.

---

# **END OF EXIT RULES**

This document defines EXACTLY how SAS closes positions.
It is the single most important safety mechanism in the system.

