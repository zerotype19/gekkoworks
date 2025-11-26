---

# 📘 `/docs/execution.md`

**SAS Execution & Order Management v1.0**
**Status: Canonical Specification (NON-OVERRIDABLE)**

This is the most tightly controlled document in SAS.
Execution rules govern every interaction with the broker.
Precision here prevents catastrophic losses.

---

# **1. Purpose of Execution Rules**

Execution rules define:

* How orders must be priced
* Slippage boundaries
* Time-to-fill limits
* Cancel/replace logic
* Data validation
* Fail-safe behavior
* Allowed order types
* Forbidden behaviors

Execution is the most fragile and dangerous part of the system.
These rules ensure it is safe.

---

# **2. Allowed Order Types**

Only one order type is allowed for v1:

```
LIMIT MULTILEG ORDER
```

NO MARKET ORDERS.
NO STOP ORDERS.
NO CONDITIONAL ORDERS.
NO OCO/OTO.
NO ALTERNATIVE ROUTING CHOICES.

The system must never use any other order type.

---

# **3. Limit Price Setting Rules**

This is the MOST IMPORTANT section of execution.

The entry limit price is defined as:

```
limit_price = mid_price - entry_slippage
```

Where:

```
mid_price = (bid_short - ask_long) / 2 + (ask_short - bid_long) / 2  # effectively mid of credit spread
entry_slippage = 0.02
```

Hard constraints:

```
entry_slippage ∈ {0.02}   # fixed for v1
limit_price ≥ 0.60         # absolute minimum allowed credit
limit_price ≤ 3.00         # safety max
```

NEVER widen.

NEVER chase.

NEVER adjust.

Cursor must NEVER compute a limit price using any other formula.

---

# **4. Order Submission Rules**

Upon authorization:

1. Build Tradier multileg order:

   * Leg 1: sell_to_open (short_put)
   * Leg 2: buy_to_open  (long_put)
2. quantity = 1
3. type = "limit"
4. price = limit_price
5. duration = "day"
6. tag = "SAS_ENTRY"

Order must be submitted **within 1 second** of approval.

---

# **5. Fill Monitoring Logic**

After submission:

* Poll Tradier every **2 seconds** for order status.
* Maximum fill waiting period:

```
max_fill_time = 20 seconds
```

Fill states considered valid:

* “filled”
* “fully_filled”
* (or equivalent per Tradier API)

If filled:

* Record fill price
* Update trade to OPEN
* Immediately enter monitoring loop for exits

If NOT filled by 20 seconds → **cancel order**.

---

# **6. Cancel Logic**

If order is not filled within 20 seconds:

1. Send cancel request
2. Confirm cancel state from Tradier
3. Mark trade as:

   ```
   status = CANCELLED
   reason = "timeout_no_fill"
   ```
4. DO NOT reattempt entry in same cycle
5. DO NOT widen price
6. DO NOT resubmit automatically

Cursor must obey this strictly.

---

# **7. Forbidden Execution Behaviors**

Cursor cannot:

* Replace an order unless explicitly allowed (v1: not allowed)
* Widen limit price
* Adjust slippage
* Try multiple fills
* Modify quantity
* Convert to market
* Continue polling past time limit
* Continue monitoring after cancellation
* Infer fill price
* Guess at bid/ask
* Use different pricing formula
* Retry entry automatically

These are absolute prohibitions.

---

# **8. Execution Failure Handling**

If ANY of the following occur:

* Tradier returns an error
* Order rejected
* Order routing error
* Missing response fields
* HTTP failure
* Unexpected order state
* Price NaN or null
* Internal math error

Then:

* Cancel the order immediately
* Mark trade as CANCELLED
* Do not retry
* Do not widen
* Do not trade this cycle

---

# **9. Entry → Open State Transition**

A trade transitions from ENTRY_PENDING to OPEN only when:

```
order_state == filled AND
fill_price is a valid number AND
both legs filled (Tradier reports full fill)
```

Cursor must validate all conditions.

---

# **10. Post-Entry Safety Checks**

Immediately after fill:

1. Recompute delta and mid
2. Recompute EV (should still be positive)
3. Cache all metrics
4. Begin exit monitoring

If any critical metric corrupted → emergency close (defined in exit rules file).

---

# **END OF EXECUTION RULES**

This file defines **exactly** how orders enter the market.
The next file will handle how orders EXIT.

---

