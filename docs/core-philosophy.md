I’m choosing the option that **guarantees the strongest foundation**, prevents mistakes later, and gives Cursor a North Star that cannot drift:

# ✅ **We start with the *Core Philosophy***

(then Strategy Engine, Scoring, Execution, Exits, and the rest will follow in the proper order.)

Here’s why I’m choosing this — and this is important:

* **Without the Core Philosophy, Cursor will reinterpret technical rules later.**
* **Without the Philosophy, the Strategy Engine becomes fragile.**
* **Without the Philosophy, risk discipline weakens when rules get complex.**
* **Without the Philosophy, we risk repeating the $200k mistake.**

The Core Philosophy is not fluff.
It defines:

* How the system *thinks*
* What is allowed
* What is forbidden
* How strictness works
* System identity
* Intent
* Execution doctrine

It is the document that prevents ambiguity everywhere else.

Everything you asked for — precision, edge-based strategy, strict exits, protection from drift, no guessing — stems from this.

This is the **Constitution**.
All other MD files are subordinate to this one.

So I’m starting here.

---

# 📘 `/docs/core-philosophy.md` (DRAFT 1 – The Trading Constitution)

Below is the full Core Philosophy document exactly as it should appear in your repo.
Nothing is left vague.
Nothing is philosophical fluff.
Every line is operational doctrine.

---

# **SAS Trading System — Core Philosophy**

**Version: 1.0**
**Status: Governing Document (NON-OVERRIDABLE)**

This document defines the **immutable principles** of the SAS trading system.
These principles are **not negotiable, not adjustable, and not subject to interpretation by Cursor or future developers.** They govern every strategy, every score, every execution step, every exit, and every enhancement.

Failure to follow this document results in system drift, unintended risk exposure, and catastrophic drawdowns.

This system is designed for **precision, speed, discipline, and statistical edge extraction** — not speculation or discretionary trading.

---

# **1. The Prime Directive: Mechanical, Edge-Based, Zero-Discretion Trading**

SAS exists to **identify, capture, and exit statistically favorable option premium structures** with *zero human discretion*.

The system:

* Does not guess
* Does not hope
* Does not wait
* Does not “see what happens next”
* Does not widen stops
* Does not hold losing trades “a bit longer”
* Does not chase fills
* Does not override mechanical rules

All decisions must be:

* Explicit
* Binary
* Repeatable
* Backtestable
* Numerically defined

The system is not “smart” — it is **consistent**.

---

# **2. The Edge: Extractable Market Inefficiencies Only**

SAS trades only when there is mathematically measurable *edge*.
Edge is defined as:

> **The presence of a statistically favorable imbalance between implied volatility, realized volatility, skew, and option pricing relative to true probability of outcome.**

The system trades ONLY when:

* IV > RV
* IVR is in the “opportunity zone”
* Skew favors premium selling
* Expected value is positive
* Tail risk is controlled
* Credit relative to width is favorable

If ANY of these conditions fail → **no trade**.

This system must never become a “put spread vending machine.”

---

# **3. System Identity: Professional, Unemotional, Ruthless Risk Management**

SAS behaves like a professional market participant:

* It enters when the edge is present.
* It exits when the reasons to stay disappear.
* It closes losing trades immediately when thresholds are hit.
* It ignores opinions, charts, and narratives.
* It never tries to be “right.”
* It survives first. Profit second.

Humans destroyed $200,000 with discretion.
This system exists to prevent that from ever happening again.

---

# **4. Time Sensitivity: Seconds Matter**

The system must act:

* Immediately
* Without hesitation
* Within seconds of a signal

Delays destroy edge.
Delays increase slippage.
Delays turn winners into losers.

SAS is a **high-discipline execution machine**, not a slow model.

---

# **5. No Discretion in Entries or Exits**

Every input to the system must be mechanical:

### **Allowed:**

* Calculations
* Formulas
* Thresholds
* Deterministic score comparisons
* Binary yes/no conditions
* Strict credit/width/delta/IVR/skew limits

### **Forbidden:**

* “Feelings”
* “Looks good enough”
* “Maybe it will bounce”
* “Let’s try widening the credit”
* “Let’s hold overnight because the market is oversold”
* Any behavior not explicitly defined in MD files

Cursor must NEVER make “judgment calls.”

---

# **6. Auto-Execution of Both Entry and Exit**

Every trade must be:

1. **Opened automatically**
2. **Monitored continuously**
3. **Closed automatically**

Human review is informational only.
Humans cannot override execution.

---

# **7. Precision Scoring Determines Everything**

Scoring is the central intelligence of SAS.

* If score ≥ threshold → trade allowed
* If score < threshold → no trade

No exceptions.

Scoring integrates:

* IVR sweet spot
* RV/IV alignment
* Vertical skew
* Horizontal term structure
* Delta fitness
* Probability of profit
* Expected value

Scoring is:

* Mathematical
* Weighted
* Normalized
* Never discretionary

Scoring changes ONLY via explicit modification of `scoring-model.md`.

---

# **8. Strict Entry Logic**

Entries must follow:

* Exact limit-order logic
* Exact mid-price calculations
* Exact slippage bounds
* No chase
* No “second try” unless defined
* No widening bids
* Cancel if not filled in allowed time
* Never convert to market

This protects the system from execution bleed.

---

# **9. Strict Exit Logic**

Exits must be automatic when ANY exit rule triggers:

* Profit target
* Stop loss
* DTE rule
* Liquidity collapse
* Emergency rule

Exits must:

* Use deterministic limit logic
* Execute immediately
* Never widen
* Never delay
* Never ignore a trigger
* Be final once filled

The system must never “let it ride.”

---

# **10. Safety Before Profit**

Rules that protect capital override rules that grow capital.

Example:

* If expected value is high but IV skew risk is extreme → no trade
* If profit target reached but we “think it could go higher” → exit
* If stop loss hit but spread looks likely to bounce → exit anyway
* If DTE is 2 or lower → exit regardless of unrealized PnL

The system must never maximize return at the expense of survival.

---

# **11. Transparency and Traceability**

Every trade must have:

* Logged scores
* Logged decision reasoning
* Logged risk state
* Logged IV, RV, delta, skew
* Logged time of entry and exit
* Logged order responses
* Logged PnL

No black-box behavior.

---

# **12. No Strategy Drift Over Time**

Cursor must never:

* Modify rules without explicit MD file changes
* Infer missing pieces
* Add complexity that isn’t requested
* Simplify formulas
* Generalize scoring
* Experiment with new strategies
* Change scalars, thresholds, or boundaries

SAS must remain exactly as written.

If strategy changes occur, they must:

1. Be defined in MD files
2. Be versioned
3. Be cryptographically recorded in the repo
4. Require explicit human approval

---

# 🔥 **END OF DOCUMENT**

This file defines SAS’s identity — everything else is execution.

---
