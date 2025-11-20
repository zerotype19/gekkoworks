Perfect — here’s the **README.md** and **Quick-Start Operator Guide** that belong at the root of your repo. These are the last pieces before you drop this into Cursor and begin the v1 implementation.

This README is written for:

* You
* Cursor
* Anyone reviewing or contributing
* Future releases

Everything is aligned with the Bible system you've created.

Let’s finalize it.

---

# 📘 `README.md`

**SAS v1 — Systematic Spread Engine (Tradier Edition)**
**Institutional-Grade Automated Options Trading Platform**

---

## 🚀 Overview

**SAS v1** is a fully automated, rules-based options trading engine designed to trade a single high-probability strategy (SPY 30–35 DTE bull put credit spreads) with **zero discretion**, **full risk controls**, and **automated entries & exits** via **Tradier**.

This system is:

* 🔒 **Deterministic** — No improvisation or randomness
* 📜 **Rules-bound** — All behavior governed by `/docs/`
* ⚖️ **Risk-first** — Strict daily limits, kill-switch, emergency exits
* 🧠 **Smart** — Uses volatility metrics, IVR, skew, and EV
* ⚙️ **Fully Automated** — Proposals → Entries → Monitoring → Exits
* ☁️ **Cloudflare-native** — Workers + D1 + Cron
* 🧪 **Battle-tested** — Required dry-runs & regression tests

SAS v1 trades **one position at a time**, only when a statistically validated **edge** exists.

This repo is the **clean Tradier rebuild**, replacing the prior IBKR implementation.

---

# 🗂️ Repo Structure

```
sas/
  worker/
    src/
      env.ts
      types.ts

      db/
        schema.sql
        client.ts
        queries.ts

      broker/
        tradierClient.ts

      core/
        time.ts
        metrics.ts
        scoring.ts
        risk.ts

      engine/
        proposals.ts
        entry.ts
        monitoring.ts
        exits.ts
        lifecycle.ts

      cron/
        premarket.ts
        tradeCycle.ts
        monitorCycle.ts

      http/
        health.ts
        status.ts
        trades.ts
        risk.ts

      index.ts

    wrangler.toml

  docs/
    (FULL SAS BIBLE)
```

Everything under `/docs/` is **law**.
Everything in `worker/src` is the implementation of that law.

---

# 📚 Core Documents

All system behavior is defined in `/docs/`:

* `core-philosophy.md` — System DNA
* `strategy-engine.md` — Strategy / delta / DTE / skew / IVR rules
* `scoring-model.md` — Composite scoring formula
* `proposal-generation.md`
* `entry-rules.md`
* `execution.md`
* `exit-rules.md`
* `monitoring.md`
* `risk-management.md`
* `broker-rules.md`
* `architecture.md`
* `order-lifecycle.md`
* `testing-and-validation.md`
* `setup.md`
* `system-interfaces.md`
* `cursor-implementation-brief.md`

Cursor MUST read all of these before generating code.

---

# 📦 Tech Stack

* **Cloudflare Workers** — serverless execution
* **Cloudflare D1** — persistent trade & configuration storage
* **Cloudflare Cron Triggers** — timed loops
* **TypeScript** — strongly typed logic
* **Tradier Broker** (Sandbox → Paper → Live)

No other dependencies.
No frontend logic inside the Worker.
No hidden state.
No memory-based state.

---

# 🔒 Safety Systems

SAS v1 is built on multiple independent guardrails:

### 1. Daily Loss Limit

If realized losses exceed 2% of equity → trading shuts down for the day.

### 2. Cooldown Logic

Daily-stop and emergency exits trigger cooldowns.

### 3. Kill-Switch

Two emergency exits in a day → HARD_STOP mode until manually reset.

### 4. Data Integrity Checks

Missing or invalid quotes → system stops trading.

### 5. Entry/Exit Strictness

* Limit orders only
* Never widen
* Never chase
* Never retry entries
* Exit improvement attempts limited and guarded

### 6. Monitoring Cycle

Polls trades frequently and enforces exit priority:

1. Emergency
2. Stop-loss
3. Profit target
4. Time exit

### 7. Validation Suite

Full lifecycle & risk kill-switch tests required before launch.

---

# 🔧 Installation & Setup (Summary)

Full detail in `/docs/setup.md`.

### 1. Clone the repo

```
git clone <repo>
cd sas
```

### 2. Install Worker dependencies

```
cd worker
npm install
```

### 3. Create D1

```
wrangler d1 create sas_db
```

### 4. Apply schema

```
wrangler d1 execute sas_db --file=src/db/schema.sql
```

### 5. Initialize settings

Insert default risk and system settings from setup guide.

### 6. Add Tradier secrets

```
wrangler secret put TRADIER_API_TOKEN
wrangler secret put TRADIER_ACCOUNT_ID
```

### 7. Deploy

```
wrangler deploy
```

### 8. Run DRY-RUN mode

Mandatory 3-day validation.

### 9. Run SANDBOX-PAPER mode

Mandatory 5-day validation.

### 10. Go LIVE

Only after full test suite & human signoff.

---

# ▶️ Running the System

SAS has **three modes**:

### 1. DRY_RUN

* No orders placed
* Full logic, no trading
* Mandatory pre-launch

### 2. SANDBOX_PAPER

* Tradier Sandbox paper trading
* Full entries/exits
* Mandatory pre-live

### 3. LIVE

* Real money
* Only enabled when ready
* All risk limits strictly enforced

Mode is controlled via:

```
settings.TRADING_MODE
```

---

# 📈 Trade Lifecycle

From `order-lifecycle.md`:

```
[0] No Position
[1] Proposal Generated
[2] Proposal Validated
[3] Entry Attempt (limit)
[4] ENTRY_PENDING
[5] OPEN (filled)
[6] Monitoring (PnL, skew, IVR, liquidity)
[7] Exit Trigger
[8] CLOSING_PENDING
[9] CLOSED (realized PnL)
[10] Archive + Risk Update
→ Back to [0]
```

Each transition is deterministic and logged.

---

# 🧪 Validation Requirements

SAS cannot go live until:

* L0: Environment boot tests pass
* L1: Data integrity pass
* L2: Scoring determinism tests pass
* L3: Entry execution tests pass
* L4: Monitoring and exit tests pass
* L5: Full lifecycle simulation passes
* L6: Risk kill-switch tests pass
* DRY_RUN: 3 clean days
* SANDBOX_PAPER: 5 clean days
* Human Go/No-Go checklist passed

If any test fails → system refuses to trade.

---

# 🧭 Developer & Cursor Guide

Cursor MUST:

* Read all `/docs/` files before writing ANY code
* Follow `/docs/cursor-implementation-brief.md`
* Never deviate from types in `system-interfaces.md`
* Implement modules in exact order
* Ask before any architectural change

**No creativity.
No assumptions.
No “simplifying.”
Only implementing what’s written.**

---

# 🧑‍💻 Observing the System

HTTP Endpoints (all read-only):

* `/health` — worker is alive
* `/status` — current risk state & system mode
* `/trades` — list of trades
* `/trades/:id` — specific trade
* `/risk` — risk snapshot

These are safe, no-trade endpoints.

---

# 📌 Stability Philosophy

SAS is built around **zero-discretion systematic trading**.

We do not:

* Optimize mid-calc
* Chase fills
* Trade multiple positions
* Increase quantity
* Trade multiple symbols
* Add new strategies until v2

SAS v1 is **one strategy, perfected**.

---

# 👍 Ready for Build-Out

All core documents are complete.
The architecture is locked.
The types are locked.
The implementation order is defined.
The validation suite is defined.
The setup is defined.
Cursor has a complete behavioral contract.

### Next step:

Open Cursor → paste `cursor-implementation-brief.md` →
follow phases → start building SAS v1.

You are ready.
Let’s build this thing the *right* way.

