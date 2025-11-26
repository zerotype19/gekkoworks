Good, we’re closing the loop now.
I’m going to give you the **setup Bible** so you can nuke the IBKR mess and stand up a clean Tradier-based SAS v1 repo with confidence.

I’m choosing **`/docs/setup.md`** as the next doc.

---

# 📘 `/docs/setup.md`

**SAS v1 Setup & Bootstrap Guide**
**Status: Canonical Setup Specification (NON-OVERRIDABLE)**

This document defines the **exact steps** required to:

* Create the new SAS repo
* Configure Cloudflare Worker + D1
* Wire Tradier credentials
* Initialize schema and settings
* Configure crons
* Run the first dry-run cycle safely

No steps may be skipped.
No “shortcuts.”
Cursor must follow this as the playbook.

---

## 1. Prerequisites

Before setup, you MUST have:

1. **Cloudflare account** with:

   * Workers enabled
   * D1 enabled

2. **Tradier account** with:

   * Sandbox API token
   * Paper trading account ID

3. **Local tooling**:

   * `node` (LTS)
   * `npm` or `pnpm`
   * `wrangler` CLI (latest)

4. **GitHub repo** created (e.g., `sas-tradier-v1`).

---

## 2. Repo Initialization

From your terminal:

```bash
mkdir sas-tradier-v1
cd sas-tradier-v1
git init
```

Create basic structure:

```bash
mkdir -p worker/src/{db,broker,core,engine,cron,http}
touch worker/src/index.ts
touch worker/wrangler.toml
mkdir -p docs
```

Copy all MD “Bible” docs into `docs/`:

* `core-philosophy.md`
* `strategy-engine.md`
* `scoring-model.md`
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
* `setup.md` (this file)

These are the governing documents for the repo.

---

## 3. Worker Project Setup

Inside `worker/`:

```bash
cd worker
npm init -y
npm install typescript esbuild @cloudflare/workers-types
npx tsc --init
```

Minimal `tsconfig.json` adjustments:

* `module`: `"esnext"`
* `target`: `"esnext"`
* `moduleResolution`: `"bundler"`
* `lib`: `["ESNext", "WebWorker"]`
* `strict`: `true`

Cursor will handle the exact config, but it MUST be TS + Workers-aware.

---

## 4. `wrangler.toml` Configuration

`worker/wrangler.toml` must include at minimum:

```toml
name = "sas-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[vars]
TRADIER_ENV = "sandbox"

# These will be set via `wrangler secret put`:
# TRADIER_API_TOKEN
# TRADIER_ACCOUNT_ID

[[d1_databases]]
binding = "DB"
database_name = "sas_db"
database_id = "<TO_BE_FILLED_AFTER_CREATE>"

[triggers]
crons = [
  "0 13 * * MON-FRI",   # premarket check (e.g., 8:00 ET)
  "*/1 14-20 * * MON-FRI",     # trade cycle (every 1 min during RTH)
  "1-59/1 14-20 * * MON-FRI"  # monitor cycle (every 1 min during RTH, offset)
]
```

Cloudflare cron granularity is minute-based, so the monitoring loop runs every 1 minute during market hours. The system includes early-exit gates to avoid unnecessary broker calls when no trades are active.

We will treat these as **minimum** schedules; the logic inside must still follow monitoring/exit rules.

---

## 5. Create D1 Database

From repo root (or inside `worker`):

```bash
wrangler d1 create sas_db
```

Copy the `database_id` returned into `wrangler.toml` under `database_id`.

---

## 6. Define Schema & Migrations

Create `worker/src/db/schema.sql` with:

* `trades` table
* `proposals` table
* `settings` table
* `risk_state` table

Cursor should implement schema consistent with the architecture + lifecycle docs. Example shape (simplified):

```sql
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  proposal_id TEXT,
  symbol TEXT NOT NULL,
  expiration TEXT NOT NULL,
  short_strike REAL NOT NULL,
  long_strike REAL NOT NULL,
  width REAL NOT NULL,
  entry_price REAL,
  exit_price REAL,
  max_profit REAL,
  max_loss REAL,
  status TEXT NOT NULL,
  opened_at TEXT,
  closed_at TEXT,
  exit_reason TEXT,
  broker_order_id_open TEXT,
  broker_order_id_close TEXT,
  realized_pnl REAL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  expiration TEXT NOT NULL,
  short_strike REAL NOT NULL,
  long_strike REAL NOT NULL,
  width REAL NOT NULL,
  credit_target REAL NOT NULL,
  score REAL NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Then create a migration:

```bash
wrangler d1 execute sas_db --file=src/db/schema.sql
```

(Or use `migrations` directory; up to you, but the schema above must exist.)

---

## 7. Initialize Settings & Risk State

Use the D1 console or `wrangler d1 execute` to insert initial settings:

```sql
INSERT OR REPLACE INTO settings (key, value)
VALUES
  ('MAX_TRADES_PER_DAY', '1'),
  ('MAX_DAILY_LOSS_PCT', '0.02'),
  ('ACCOUNT_EQUITY_REFERENCE', '100000');

INSERT OR REPLACE INTO risk_state (key, value)
VALUES
  ('SYSTEM_MODE', 'NORMAL'),
  ('RISK_STATE', 'NORMAL'),
  ('EMERGENCY_EXIT_COUNT_TODAY', '0'),
  ('LAST_HARD_STOP_AT', '');
```

These values can be tuned later but MUST exist.

---

## 8. Configure Tradier Secrets

From `worker/`:

```bash
wrangler secret put TRADIER_API_TOKEN
wrangler secret put TRADIER_ACCOUNT_ID
```

Values:

* `TRADIER_API_TOKEN`: your Tradier sandbox token
* `TRADIER_ACCOUNT_ID`: your Tradier sandbox account id

Confirm `TRADIER_ENV = "sandbox"` in `wrangler.toml`.

---

## 9. Implement Worker Entrypoint Stub

`worker/src/index.ts` must:

* Export `fetch` handler
* Export `scheduled` handler
* Delegate to:

  * `cron/premarket.ts`
  * `cron/tradeCycle.ts`
  * `cron/monitorCycle.ts`
  * `http/*` routes

Initially, you can implement no-op logic, but the routing structure must match the **architecture.md** doc.

---

## 10. Bring in the Core Modules (Cursor Work)

At this point, Cursor should:

1. Implement `env.ts` (Env type).
2. Implement `db/client.ts` + `db/queries.ts`.
3. Implement `broker/tradierClient.ts` per `broker-rules.md`.
4. Implement `core/metrics.ts`, `core/scoring.ts`, `core/risk.ts`.
5. Implement `engine/proposals.ts`, `engine/entry.ts`, `engine/monitoring.ts`, `engine/exits.ts`, `engine/lifecycle.ts`.
6. Implement `cron/premarket.ts`, `cron/tradeCycle.ts`, `cron/monitorCycle.ts`.
7. Implement read-only HTTP routes in `http/`.

All code MUST follow the Bible docs; no “creative” deviations.

---

## 11. First Deploy (Dry Infrastructure Check)

From `worker/`:

```bash
wrangler deploy
```

Then hit `/health`:

* Should return something like `{ status: "ok" }`
* No exceptions or crashes in logs

If `/health` fails → fix before proceeding.

---

## 12. Enable DRY-RUN Mode (No Orders)

Before ANY real orders:

* Add a config flag in `settings` table, e.g.:

```sql
INSERT OR REPLACE INTO settings (key, value)
VALUES ('TRADING_MODE', 'DRY_RUN');
```

Behavior:

* Proposal engine runs normally
* Entry engine computes everything, but **does not call Tradier order placement**
* Instead logs “DRY_RUN_ENTRY” with hypothetical limit price and state
* Monitoring/exit can operate on simulated fills if you choose, or you can stub trade state transitions

You MUST run DRY-RUN for at least 3 sessions per `testing-and-validation.md`.

---

## 13. Turn On Sandbox Auto-Mode (Paper Trading)

When DRY-RUN passes:

1. Update `settings`:

```sql
UPDATE settings SET value = 'SANDBOX_PAPER' WHERE key = 'TRADING_MODE';
```

2. Ensure `TRADIER_ENV = "sandbox"` (still).
3. Confirm:

   * Proposals are generated
   * Entries are sent as **sandbox orders**
   * Fills are handled correctly
   * Exits are placed and filled

Run for at least 5 clean days.

---

## 14. Transition to Live (Only After All Tests)

When you are absolutely ready:

1. Switch `TRADIER_ENV` to `"live"` in `wrangler.toml`.
2. Replace secrets with live API token & account id:

```bash
wrangler secret put TRADIER_API_TOKEN
wrangler secret put TRADIER_ACCOUNT_ID
```

3. Update `settings.TRADING_MODE` to `'LIVE'`.
4. Ensure:

   * DAILY_LOSS_PCT and ACCOUNT_EQUITY_REFERENCE match actual account risk
   * `SYSTEM_MODE = "NORMAL"`
   * No stale open trades in D1 that conflict with live account

Only then is LIVE trading allowed.

---

## 15. Manual Go/No-Go Checklist

Before flipping to LIVE:

* [ ] `wrangler deploy` successful with no runtime errors
* [ ] `/health` = ok
* [ ] D1 schema present and correct
* [ ] `settings` and `risk_state` tables populated
* [ ] DRY-RUN mode tested for ≥ 3 days
* [ ] SANDBOX_PAPER tested for ≥ 5 days
* [ ] No unexpected emergency exits
* [ ] `SYSTEM_MODE` not in HARD_STOP
* [ ] Daily loss limit and position rules enforced in logs
* [ ] Trades show correct proposal → entry → exit lifecycle
* [ ] Risk kill-switch tested and verified to disable trading

If ANY box is not fully checked → **NO GO**. Fix first.

---

## 16. Forbidden Setup Shortcuts

You MUST NOT:

* Reuse the IBKR repo or its code
* Copy partial logic from the old system that doesn’t conform to the new docs
* Bypass D1 schema and store state in memory
* “Temporarily” disable risk checks
* Allow HTTP endpoints to place orders in v1
* Run LIVE before DRY-RUN + SANDBOX_PAPER validation is complete

This setup is designed to prevent the previous disaster.
Shortcuts reintroduce those risks.

---

# END OF SETUP DOCUMENT

This gives you a clean runway from **empty repo → Cloudflare Worker + D1 → Tradier sandbox → safe dry-run → live paper → real trades**, all under the new constitution.

