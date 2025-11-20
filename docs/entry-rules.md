Buckle up — these next two documents are the *life-or-death* components of the system.

The **Entry Rules** and **Execution Rules** govern when money leaves the account, how it’s deployed, and under what conditions Cursor is *allowed* to interact with the market.

These documents exist to ensure:

* No sloppy entries
* No chasing
* No bad fills
* No execution drift
* No repeat of the $200k disaster
* Full mechanical precision
* Trades are opened only when edge exists *and* execution is clean

This is where most automated trading systems fail.
Yours will not.

We’ll create **two documents**:

1. `/docs/entry-rules.md` → WHEN a trade is allowed to be entered.
2. `/docs/execution.md` → HOW the trade is actually sent, priced, and monitored.

Let's go.

---

# 📘 `/docs/entry-rules.md`

**SAS Entry Rules v1.0**
**Status: Canonical Specification (NON-OVERRIDABLE)**

This document defines the **conditions under which SAS is allowed to enter a trade.**
Entries must be treated with the same precision as exits — no drift, no interpretation, no improvisation.

Cursor must follow these rules EXACTLY.

---

# **1. Purpose of Entry Rules**

Entry rules ensure SAS only opens positions when:

1. The statistical edge exists
2. The market conditions are stable
3. The credit is sufficient
4. The proposal is valid
5. Execution will be smooth
6. Liquidity is adequate
7. Risk is controlled
8. The system is synchronized with market microstructure

Failure on ANY point → **NO TRADE**.

---

# **2. Entry Eligibility Checklist**

Before sending ANY order, all of the following must be TRUE.
This is a hard AND/XOR chain.
No skipping allowed.

---

## **2.1 Market Hours Requirement**

Trades may ONLY be placed during:

```
9:30:00 AM to 3:50:00 PM ET
```

Reject entries if:

* Pre-market
* Post-market
* Lunch-session illiquidity (but only if bid/ask fail tolerances)
* After 3:50 PM (to prevent end-of-day fills during volatility)

Cursor must refuse to place orders outside this window.

---

## **2.2 Proposal Validation**

A proposal must be:

* From the current cycle
* Not stale (> 15 minutes old)
* Fully populated with metrics
* Above the scoring threshold
* Not previously executed
* Not manually invalidated by system safety triggers

If proposal age > 15 minutes → **reject and delete proposal**.

---

## **2.3 One-Trade-Per-Day Enforcement**

The system MUST enforce this globally:

```
max_trades_per_day = 1
```

If a trade has already been opened today → **no entry**.

No exceptions.

---

## **2.4 Credit Revalidation**

Before placing order:

Recompute:

```
live_credit = bid_short - ask_long
```

Check:

```
live_credit ≥ proposal.min_credit
live_credit ≥ 0.60 dollars (absolute floor)
```

If credit deteriorates → cancel entry.

---

## **2.5 Bid/Ask Validation**

Re-check both legs for:

* bid > 0
* ask > 0
* bid < ask
* bid/ask spread ≤ $0.15

If ANY fail → **cancel entry**.

---

## **2.6 Spread Width Validation**

Verify:

```
short_strike - long_strike = 5
```

If not → **reject proposal** (even if scoring was earlier).

---

## **2.7 Price Stability Requirement**

To avoid entering trades during microstructure instability (fast turns, fake quotes), the system requires:

```
mid-price change ≤ $0.05 over last 2 minutes
```

If mid fluctuates more than $0.05 → **no entry**.

This prevents chasing during volatility spikes.

---

## **2.8 Underlying Stability Requirement**

Verify SPY’s price movement over last minute:

```
abs(price_change_1min) ≤ 0.30%
```

If SPY is moving too fast → execution risk → skip trade.

---

# **3. Entry Authorization**

IF AND ONLY IF the following are true:

* Market hours are valid
* Proposal is valid
* No trade opened today
* Credit is valid
* Bid/ask is valid
* Stability checks pass
* Scoring ≥ threshold
* EV > 0
* All skew/IV rules satisfied

THEN the system may initiate order execution.

Otherwise → **entry forbidden**.

No override allowed.

---

# **4. Position Sizing (v1 Specification)**

Position size for v1 is fixed:

```
quantity = 1 spread (1 contract pair)
```

Future versions may scale by:

* volatility
* account balance
* rolling Sharpe

But NOT in v1.

---

# **5. Entry Timing Rules**

After entry authorization:

* Order must be placed **within 1 second**.
* Execution engine immediately takes over (per execution.md).
* If order is not sent within 3 seconds, entire cycle is invalidated.

Cursor must NOT “think,” delay, or re-evaluate.

---

# **6. Entry Rejection Rules**

A trade must be rejected (not entered) if:

* Credit collapses
* Bid-ask widens
* Underlying spikes
* IV collapses
* Any input is stale
* Expiration DTE is miscomputed
* Legs disappear from chain
* Tradier returns an error
* Data integrity fails
* Proposal does not meet freshness window
* Proposal no longer meets min credit
* Proposal no longer meets delta fitness

In all cases → **entry forbidden**.

---

# **END OF ENTRY RULES**

This file declares WHEN entry is allowed.
Next, we declare HOW entries must execute.

