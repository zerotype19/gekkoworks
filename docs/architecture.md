Here we go — this is the top-down map that tells Cursor exactly how to wire everything together.

---

# 📘 `/docs/architecture.md`

**SAS System Architecture v1.0**
**Status: Canonical Implementation Blueprint (NON-OVERRIDABLE)**

This document defines the **overall architecture** of the SAS trading system.

It specifies:

* System components
* Code organization
* Data flow
* Worker + D1 wiring
* Scheduling and entry/exit orchestration
* How all other “Bible” docs plug together

Cursor MUST adhere to this architecture.
Deviations are not allowed without an explicit versioned update.

---

## 1. High-Level Topology

SAS v1 consists of:

1. **Cloudflare Worker** – `sas-worker`

   * Core trading engine
   * Talks to Tradier
   * Runs proposal, entry, monitoring, exits
   * Exposes HTTP endpoints (`/health`, `/status`, etc.)

2. **Cloudflare D1 Database** – `sas_db`

   * Persists proposals, trades, settings, risk state, logs

3. **(Optional) Cloudflare Pages Web App** – `sas-web`

   * Read-only dashboard
   * No trading logic
   * Only reads from D1 via the Worker API

All trading logic lives in the Worker.
No other service is allowed to enter or exit trades.

---

## 2. Repository Layout

New repo structure (monorepo style):

```text
sas/
  worker/
    src/
      env.ts
      types.ts

      db/
        schema.sql
        client.ts        # thin wrapper around D1
        queries.ts       # typed helper functions

      broker/
        tradierClient.ts

      core/
        time.ts          # market hours, DTE, day-of-week
        metrics.ts       # IVR, RV/IV, skew, term structure
        scoring.ts       # implements scoring-model.md
        risk.ts          # implements risk-management.md

      engine/
        proposals.ts     # implements proposal-generation.md
        entry.ts         # implements entry-rules.md
        monitoring.ts    # implements monitoring.md
        exits.ts         # implements exit-rules.md
        lifecycle.ts     # orchestrates state transitions

      cron/
        premarket.ts     # pre-market health check
        tradeCycle.ts    # proposal + entry
        monitorCycle.ts  # monitoring + exits + risk checks

      http/
        health.ts        # /health
        status.ts        # /status
        trades.ts        # /trades (read-only)
        admin.ts         # /admin/risk-state (read-only in v1)

      index.ts           # Worker entry (fetch + scheduled)
    wrangler.toml

  web/                   # (optional dashboard)
    src/
      main.tsx
      ...
```

Cursor must place files in this structure unless a future doc changes it.

---

## 3. D1 Database & Schema

### 3.1 Binding

`wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "sas_db"
database_id = "<PROVISIONED_ID>"
```

Worker code accesses DB only via `env.DB`.

### 3.2 Core Tables (minimum required)

As defined previously (summarized):

* `trades` – one row per spread lifecycle
* `proposals` – candidate trades
* `settings` – key/value system config
* `risk_state` – current global state + flags (STOP, HARD_STOP, etc.)

Example `risk_state`:

```sql
CREATE TABLE risk_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys like: SYSTEM_MODE, RISK_STATE, EMERGENCY_EXIT_COUNT_TODAY, LAST_HARD_STOP_AT
```

All DB access must go through `db/client.ts` + `db/queries.ts` to avoid direct SQL scattered in business logic.

---

## 4. Core Modules & Responsibilities

### 4.1 `env.ts`

Defines the Worker `Env` type:

* `DB: D1Database`
* `TRADIER_ENV: string`
* `TRADIER_API_TOKEN: string`
* `TRADIER_ACCOUNT_ID: string`
* Any other config vars (log toggles, etc.)

This is the canonical environment shape.

---

### 4.2 `broker/tradierClient.ts`

Implements **`BrokerClient`** for Tradier exactly as specified in `broker-rules.md`:

* `getUnderlyingQuote(symbol)`
* `getOptionChain(symbol, expiration)`
* `placeSpreadOrder(payload)`
* `getOrder(orderId)`
* `getPositions()`

No other broker implementation in v1.
No other endpoints.

---

### 4.3 `core/metrics.ts`

Implements all **raw market metrics**:

* DTE calculation
* IVR calculation
* RV/IV ratio
* Vertical skew
* Term structure skew
* POP, EV, etc.

This module must be a pure function library (no DB, no network).

---

### 4.4 `core/scoring.ts`

Implements **`scoring-model.md`**:

* Component scores
* Normalization & clamps
* Composite score
* Reject rules when EV ≤ 0 or thresholds violated

Interface example:

```ts
export function scoreCandidate(input: CandidateMetrics): ScoringResult;
```

Where `ScoringResult` includes all component scores and final `composite_score`.

---

### 4.5 `core/risk.ts`

Implements **`risk-management.md`**:

* Read/update `risk_state` table
* Compute daily realized PnL
* Decide if new trades are allowed (`canOpenNewTrade`)
* Manage kill-switch, cooldowns, daily loss limits, etc.

Example methods:

```ts
export async function canOpenNewTrade(env: Env, now: Date): Promise<boolean>;
export async function recordTradeClosed(env: Env, trade: TradeRow): Promise<void>;
export async function checkAndApplyKillSwitch(env: Env): Promise<void>;
```

Entry/Execution/Proposal modules must call these gates before placing any order.

---

## 5. Engine Modules

### 5.1 `engine/proposals.ts`

Implements **`proposal-generation.md`**:

* Fetch SPY quote & relevant chains
* Build raw candidates
* Apply hard filters (RV/IV, IVR, skew, term structure, credit, etc.)
* Call `core/scoring` for each valid candidate
* Apply global score threshold
* Select **one** best candidate or none
* Persist proposal row in `proposals` table

No orders are placed here.
This module does NOT talk to Tradier for orders — only for quotes/chains.

---

### 5.2 `engine/entry.ts`

Implements **`entry-rules.md`** and **`execution.md`** for the **entry** side:

* Validate:

  * Market hours
  * Proposal freshness
  * One-trade-per-day limit
  * Risk gates (via `core/risk`)
  * Live credit, spreads, stability
* Compute `limit_price` using the specified formula
* Call `broker.placeSpreadOrder`
* Persist trade row with `status='ENTRY_PENDING'` and `broker_order_id_open`

Also includes short polling loop (via cron-driven repetitions) to:

* Confirm fills
* Transition from `ENTRY_PENDING → OPEN`
* Save `entry_price`, `opened_at`, `max_profit`, `max_loss`

---

### 5.3 `engine/monitoring.ts`

Implements **`monitoring.md`**:

* For all `OPEN` trades:

  * Fetch live quotes (SPY + legs)
  * Compute mark, PnL, PnL fractions
  * Detect instability (underlying spikes, liquidity collapse, quote disappearance)
  * Call exit trigger logic in `engine/exits.ts` (or return demanded action)

Monitoring logic does NOT send orders; it determines **what should happen**.

---

### 5.4 `engine/exits.ts`

Implements **`exit-rules.md`**:

* Accepts a trade + current metrics
* Decide:

  * No action
  * Profit target exit
  * Stop-loss exit
  * Time exit
  * Emergency exit
* When action required:

  * Build closing multileg order
  * Compute `close_limit`
  * Call `broker.placeSpreadOrder` for exit
  * Poll status
  * Update `exit_price`, `closed_at`, `realized_pnl`, and state transitions

The exit engine must:

* Follow strict priority order
* Apply retry behavior exactly as specified

---

### 5.5 `engine/lifecycle.ts`

Orchestrates state transitions:

* `ENTRY_PENDING → OPEN`
* `OPEN → CLOSING_PENDING`
* `CLOSING_PENDING → CLOSED`
* `OPEN → EMERGENCY_EXIT → CLOSED`

This module enforces **single-source-of-truth** for state transitions so there’s no diverging logic in different places.

---

## 6. Cron & Scheduling Architecture

The Worker uses `scheduled` events (Cloudflare cron) as pulse sources.
Internally, cron handlers call engine modules.

### 6.1 `cron/premarket.ts`

Runs **before market open** once per trading day.

Responsibilities:

* Run pre-market health check:

  * Broker connectivity
  * D1 read/write
  * Retrieve SPY quote & one chain
* Verify `RISK_STATE` not in `HARD_STOP`
* Log readiness or failure
* If failure → set `RISK_STATE = "PREMARKET_CHECK_FAILED"` and forbid new entries

---

### 6.2 `cron/tradeCycle.ts`

Runs **during market hours** at a moderate frequency (e.g., every 5–15 minutes).

Responsibilities (in order):

1. Check:

   * Market hours
   * Risk gates (`canOpenNewTrade`)
   * Daily loss conditions
2. If open positions exist:

   * Do **NOT** open new trades (v1 max positions = 1)
3. If no open positions and allowed:

   * Call `engine/proposals.generateProposal`
   * If proposal exists:

     * Call `engine/entry.attemptEntry`

This is the **entry** pipeline.

---

### 6.3 `cron/monitorCycle.ts`

Runs very frequently (as close to every few seconds as infra allows — spec says **2 seconds**; implementation must approximate as tightly as possible).

Responsibilities:

1. For all `OPEN` or `CLOSING_PENDING` trades:

   * Call `engine/monitoring.evaluate`
   * If an exit trigger is signaled:

     * Call `engine/exits.executeExit`
2. For all `ENTRY_PENDING` trades:

   * Check fills & transition to `OPEN` or `CANCELLED`

This is the **heartbeat** of the system.

---

## 7. Worker Entrypoint

`worker/src/index.ts` is the single Worker entry file.

It must export:

```ts
export default {
  async fetch(request, env, ctx) { ... },
  async scheduled(event, env, ctx) { ... }
}
```

### 7.1 `fetch` Routing

`fetch` must route:

* `GET /health` → `http/health.ts`
* `GET /status` → `http/status.ts`
* `GET /trades` → `http/trades.ts` (read-only, paginated)
* `GET /trades/:id` → trade detail (read-only)
* `GET /risk-state` → current risk mode (read-only in v1)

No HTTP endpoint is allowed to:

* Place trades
* Modify risk state
* Run proposal or entry flows

HTTP layer is **read-only** for v1 (observability only).

---

### 7.2 `scheduled` Routing

`scheduled` must:

* Inspect `event.cron` to determine which cron fired
* Call:

  * `cron/premarket.run` for premarket cron
  * `cron/tradeCycle.run` for intra-day trade proposal/entry cron
  * `cron/monitorCycle.run` for high-frequency monitoring cron

Logic must be clear and deterministic.

---

## 8. Observability & Debug

All logging must go through a central logger (simple abstraction):

* Include:

  * Timestamp
  * Module name
  * Trade/proposal ID (if applicable)
  * Severity (INFO/WARN/ERROR)

Key events to log:

* Proposals generated & rejected (with reasons)
* Entries attempted, filled, cancelled
* Exits triggered & executed
* Emergency exits
* Risk-state transitions
* Kill-switch activations
* Pre-market failures

Logs may be viewed via Cloudflare’s logs; no separate logging system in v1.

---

## 9. Forbidden Architectural Patterns

Cursor MUST NOT:

* Add additional Workers or services that place orders
* Put trading logic into the web/Pages app
* Allow HTTP endpoints to trigger trades in v1
* Bypass `core/risk` to place orders
* Use global variables to store trade state (state must be in D1)
* Implement background loops outside of `scheduled` events and explicit handling
* Add other broker integrations in v1
* Share DB writes between web and worker without going through defined queries

All trading must flow through:

> cron → engine (proposal/entry/monitor/exit) → broker → D1

---

## 10. End-to-End Lifecycle Summary

1. **Pre-market**

   * `cron/premarket` validates environment
   * Risk state confirmed safe

2. **Proposal + Entry**

   * `cron/tradeCycle` runs during market hours
   * Risk gates checked
   * `engine/proposals` generates a single best candidate
   * `engine/entry` validates and sends limit order to Tradier

3. **Open Position Monitoring**

   * `cron/monitorCycle` runs frequently
   * `engine/monitoring` computes PnL, instability
   * Exit triggers evaluated per priority
   * `engine/exits` sends closing orders

4. **Closure & Risk Updates**

   * Trade is marked CLOSED
   * `core/risk` updates daily PnL, exit counts, kill-switch states

5. **Observation**

   * Web app / operators query `GET /status` and `GET /trades`
   * No manual overrides in v1 (just read-only observability)

---

### END OF ARCHITECTURE DOCUMENT

This is the **wiring diagram** for SAS:
how the bibles plug into a real, running system.

