

# 📘 `/docs/risk-management.md`

**SAS Risk Management v1.0**
**Status: Canonical Specification (NON-OVERRIDABLE)**

This document defines the **portfolio-level safety system** for SAS.

Individual trades have:

* Entries (entry-rules.md)
* Execution details (execution.md)
* Exits (exit-rules.md)

Risk Management controls the **system as a whole**:

* How much risk is allowed per day
* How much capital can be exposed
* When the system must shut itself off
* When it must cool down
* When NOT to trade at all

Cursor MUST implement these constraints exactly.
No softening. No “optimizations.” No overrides.

---

## 1. Core Risk Principles

1. **Capital preservation comes before profit.**
2. **No single day can materially damage the account.**
3. **No single trade can materially damage the account.**
4. **The system must have an internal kill-switch.**
5. **The system must enforce cool-downs after losses.**
6. **The system must refuse to trade in abnormal environments.**

These rules take precedence over:

* Entry rules
* Strategy rules
* Profit opportunities

If risk and opportunity conflict → **risk wins.**

---

## 2. Account Context & Config Parameters

For v1, we treat some values as configurable settings stored in D1 (or config file), but enforced mechanically:

* `ACCOUNT_EQUITY_REFERENCE` — reference account size (e.g., 100,000)
* `MAX_DAILY_LOSS_PCT` — 2% (0.02)
* `MAX_DAILY_REALIZED_LOSS` = `ACCOUNT_EQUITY_REFERENCE * MAX_DAILY_LOSS_PCT`
* `MAX_OPEN_POSITIONS` — 1 (v1)
* `MAX_TRADES_PER_DAY` — 1 (v1)
* `MAX_NOTIONAL_PER_TRADE` — `width * 100 * quantity` (implicitly bounded since width = 5 and quantity = 1)
* `COOLDOWN_DAYS_AFTER_DAILY_STOP` — 1 trading day
* `COOLDOWN_DAYS_AFTER_EMERGENCY_EXIT` — 1 trading day

These values must be stored and enforced.
Cursor must NOT change them without spec updates.

---

## 3. Daily Loss Limit (Hard Stop)

Each trading day, system must compute:

```
daily_realized_pnl = Σ realized_pnl for trades CLOSED today
```

Daily loss is:

```
daily_loss = min(daily_realized_pnl, 0)   # negative or zero
```

If:

```
abs(daily_loss) ≥ MAX_DAILY_REALIZED_LOSS
```

Then:

1. **Immediately disable new entries** for the rest of the day.
2. Flag system state: `RISK_STATE = "DAILY_STOP_HIT"`.
3. Continue monitoring existing open positions; exits remain active.
4. Do NOT reopen trading until **next trading day** AND cooldown check passes.

Cursor MUST NOT override this.
No “just one more trade.”
No “we’ll make it back.”

---

## 4. Max Open Positions

For v1:

```
MAX_OPEN_POSITIONS = 1
```

At any moment:

```
open_positions_count = number of trades with status in {OPEN, CLOSING_PENDING}
```

If `open_positions_count ≥ 1`:

* Do NOT open new positions
* The Proposal Engine may still generate proposals, but Execution Engine MUST refuse to enter new trades

This enforces serial, not parallel, risk exposure in v1.

---

## 5. Max Trades Per Day

For v1:

```
MAX_TRADES_PER_DAY = 1
```

At the start of every entry cycle:

```
trades_today = count of trades with opened_at date == today
```

If `trades_today ≥ MAX_TRADES_PER_DAY`:

* Execution Engine MUST refuse new trades
* Proposal Engine may still evaluate, but nothing can be executed

This keeps daily exposure simple and controlled.

---

## 6. Volatility Circuit Breakers (Macro Risk)

The system must refuse to open NEW positions when macro conditions are dangerously unstable, even if a proposal scores highly.

### 6.1 VIX-based Filter (if VIX data available)

If we ingest VIX:

```
if VIX ≥ 30 → forbid new entries
```

Existing positions can still be monitored and exited.

If VIX not available, this rule can be disabled explicitly in config — but **MUST NOT** be silently ignored. Either:

* `VIX_CHECK_ENABLED = true` and enforced,
  or
* `VIX_CHECK_ENABLED = false` and logged as disabled.

No “auto-guessing” behavior.

---

### 6.2 SPY Intraday Volatility Filter

Even without VIX, SPY itself provides a circuit breaker.

System must forbid new entries if:

* SPY has moved > **1.5%** intraday from previous day’s close, AND
* 1-minute volatility > **0.40%** over the last 5 minutes

In that case:

* Proposal Generation may still run
* Execution must not enter new positions
* Flag `RISK_STATE = "INTRADAY_VOL_CIRCUIT_ON"`

---

## 7. Emergency Kill Switch

If any of the following occurs:

* Multiple emergency exits in a single day (e.g., `EMERGENCY_EXIT_COUNT >= 2`)
* Mark-to-market loss across OPEN positions > **3%** of reference equity
* Monitoring loop failure persists > 30 seconds
* Broker outages lasting > 30 seconds
* Data integrity failures on consecutive cycles (> 5 in a row)

Then:

1. Immediately:

   * For all OPEN positions → trigger emergency exits
2. Set:

   * `SYSTEM_MODE = "HARD_STOP"`
   * `SYSTEM_RESTART_AFTER = next trading day (manual override required)`
3. Block:

   * All new entries
   * All new proposals from being executed

The system must NOT restart itself automatically from HARD_STOP.
A human must explicitly reset it.

---

## 8. Cooldown Logic

**Scenario A: Daily loss stop hit (but no hard stop)**

When daily loss limit is hit:

* Flag `RISK_STATE = "DAILY_STOP_HIT"`
* Disallow new entries for the rest of the day
* On next trading day:

  * Reset `RISK_STATE` to `NORMAL`
  * Resume normal operation

**Scenario B: Emergency exit occurred**

If any trade used Emergency Exit:

* Flag `RISK_STATE = "EMERGENCY_EXIT_OCCURRED_TODAY"`
* Prevent new entries for the rest of the day
* On next trading day:

  * If NO new systemic errors → normal operation permitted
  * If repeated -> escalate to HARD_STOP (Section 7)

---

## 9. Pre-Market Health Check

Before the system is allowed to trade on any given day, a pre-market validation must run (can be a cron early in the morning):

Checks:

1. Can we:

   * Connect to Tradier?
   * Fetch SPY quote?
   * Fetch at least one valid option chain for the target DTE window?
2. Is:

   * D1 database reachable?
   * Read and write operations working?
3. Are:

   * Critical settings (`MAX_TRADES_PER_DAY`, `MAX_DAILY_LOSS_PCT`) present and valid?
4. Is:

   * `SYSTEM_MODE != "HARD_STOP"`
   * If `HARD_STOP` is set → refuse all trading

If any test fails:

* Set `RISK_STATE = "PREMARKET_CHECK_FAILED"`
* Disallow new entries
* Allow only closing of existing positions

---

## 10. Position-Level Risk Caps (Redundancy)

Redundancy is on purpose. Even though width is small and hard-coded, each trade must pass:

### 10.1 Max per-trade risk:

```
max_loss ≤ ACCOUNT_EQUITY_REFERENCE * 0.01
```

(1% of equity).

Given small width and 1 lot, this is trivially satisfied now — but the rule MUST exist, enforced in code, and block future scaling mistakes.

### 10.2 No naked legs

Position is invalid if:

* Long leg missing
* Short leg only

System must never allow a state where the hedge leg is missing (except briefly during emergency close operations). If detected in normal operation → treat as **critical emergency**.

---

## 11. Risk and Logging

Risk subsystem MUST log:

* Daily realized PnL
* Current open risk
* Max intraday drawdown
* When daily stop hit
* When kill-switch triggered
* When cooldown mode is on
* When pre-market check fails
* When circuit breakers are active

These logs must be persistent and auditable.

---

## 12. Forbidden Behaviors Under Risk System

Cursor MUST NEVER:

* Ignore or bypass daily loss limits
* Suppress or mask emergency conditions
* Reset flags without logic specified here
* Alter thresholds (2%, 3%, 1.5% intraday, etc.)
* Scale position size dynamically in v1
* Run additional strategies “quietly”
* Allow trading while in HARD_STOP
* Increase MAX_TRADES_PER_DAY without spec update

These are system-violation behaviors.

---

## 13. Interaction with Other Modules

Risk Management interacts with:

* **Proposal Engine**

  * May compute proposals, but Execution checks risk before sending orders.
* **Execution Engine**

  * Must always call risk checks before any new order.
* **Monitoring Engine**

  * Feeds risk metrics, such as emergency exit counts and MTM spikes.

On every entry attempt:

* Risk Manager is queried with:

  * `can_open_new_trade(today, equity_state, risk_state)?`
* If answer = `false` → no order, full stop.

---

## 14. Resetting HARD_STOP

HARD_STOP is the only state that requires **manual restart**.

Reset conditions:

* Review of logs
* Review of recent PnL
* Review of emergency exits
* Confirmation of system stability
* Explicit manual override (configuration change or admin action)

Cursor cannot auto-reset HARD_STOP.
It is a human decision.

---

### END OF RISK MANAGEMENT DOCUMENT

This file ensures the system cannot “run away” with your money, no matter how broken the market or code gets.

