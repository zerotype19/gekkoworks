Nice. We’re going to give Cursor the **wiring harness** now — the exact TypeScript interfaces and function signatures it’s allowed to use.

This will kill 90% of the “Cursor invented a weird shape” bugs you ran into before.

---

# 📘 `/docs/system-interfaces.md`

**SAS System Interfaces & Contracts v1.0**
**Status: Canonical Type & Signature Specification (NON-OVERRIDABLE)**

This document defines the **TypeScript-level contracts** for the SAS v1 system:

* Core types
* DB row shapes
* Broker client interface
* Core module APIs
* Engine module APIs
* Cron and HTTP handler contracts

Cursor MUST implement functions and types according to this spec.
It MUST NOT introduce alternate shapes or conflicting contracts.

---

## 1. Global & Env Types

### 1.1 `Env`

All Worker code should use a single shared `Env` type:

```ts
export interface Env {
  DB: D1Database;

  TRADIER_ENV: 'sandbox' | 'live';
  TRADIER_API_TOKEN: string;
  TRADIER_ACCOUNT_ID: string;

  // Optional: logging verbosity flags, etc.
  // LOG_LEVEL?: 'debug' | 'info' | 'warn' | 'error';
}
```

No other env bindings should be used without updating this file.

---

## 2. Database Row Types

These mirror D1 table schemas.
They must match actual schema fields.

### 2.1 `TradeStatus`

```ts
export type TradeStatus =
  | 'ENTRY_PENDING'
  | 'OPEN'
  | 'CLOSING_PENDING'
  | 'CLOSED'
  | 'CANCELLED'
  | 'CLOSE_FAILED';
```

### 2.2 `ExitReason`

```ts
export type ExitReason =
  | 'PROFIT_TARGET'
  | 'STOP_LOSS'
  | 'TIME_EXIT'
  | 'EMERGENCY'
  | 'UNKNOWN';
```

### 2.3 `TradeRow`

```ts
export interface TradeRow {
  id: string;                  // UUID
  proposal_id: string | null;

  symbol: string;              // 'SPY'
  expiration: string;          // ISO date 'YYYY-MM-DD'
  short_strike: number;
  long_strike: number;
  width: number;               // 5 in v1

  entry_price: number | null;  // credit received
  exit_price: number | null;   // debit paid to close
  max_profit: number | null;
  max_loss: number | null;

  status: TradeStatus;
  exit_reason: ExitReason | null;

  broker_order_id_open: string | null;
  broker_order_id_close: string | null;

  opened_at: string | null;    // ISO datetime
  closed_at: string | null;    // ISO datetime
  created_at: string;          // ISO datetime (trade record creation)
  updated_at: string;          // ISO datetime (last update)

  realized_pnl: number | null;
}
```

### 2.4 `ProposalStatus`

```ts
export type ProposalStatus = 'READY' | 'INVALIDATED' | 'CONSUMED';
```

### 2.5 `ProposalRow`

```ts
export interface ProposalRow {
  id: string;                   // UUID
  symbol: string;               // 'SPY'
  expiration: string;           // ISO date

  short_strike: number;
  long_strike: number;
  width: number;

  credit_target: number;        // target entry credit
  score: number;                // composite score (0–1)

  ivr_score: number;
  vertical_skew_score: number;
  term_structure_score: number;
  delta_fitness_score: number;
  ev_score: number;

  created_at: string;           // ISO datetime
  status: ProposalStatus;
}
```

### 2.6 `SettingRow` and `RiskStateRow`

```ts
export interface SettingRow {
  key: string;
  value: string;
}

export interface RiskStateRow {
  key: string;
  value: string;
}
```

---

## 3. Broker Layer Interfaces

Everything that touches Tradier must go through this interface.

### 3.1 Underlying Quote

```ts
export interface UnderlyingQuote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  change: number | null;
  change_percentage: number | null;
  prev_close: number | null;
}
```

### 3.2 Option Quote

```ts
export type OptionType = 'call' | 'put';

export interface OptionQuote {
  symbol: string;              // OCC option symbol
  underlying: string;          // 'SPY'
  type: OptionType;
  expiration_date: string;     // ISO date
  strike: number;

  bid: number;
  ask: number;
  last: number | null;

  delta: number | null;
  implied_volatility: number | null;
}
```

### 3.3 Order Status

```ts
export type BrokerOrderStatus =
  | 'NEW'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export interface BrokerOrder {
  id: string;                      // Tradier order id
  status: BrokerOrderStatus;
  avg_fill_price: number | null;   // per-spread or per-unit basis
  filled_quantity: number;
  remaining_quantity: number;
  created_at: string | null;
  updated_at: string | null;
}
```

### 3.4 Broker Client

```ts
export interface BrokerClient {
  getUnderlyingQuote(symbol: string): Promise<UnderlyingQuote>;

  getOptionChain(
    symbol: string,
    expiration: string
  ): Promise<OptionQuote[]>;

  placeSpreadOrder(params: PlaceSpreadOrderParams): Promise<BrokerOrder>;

  getOrder(orderId: string): Promise<BrokerOrder>;

  getPositions(): Promise<BrokerPosition[]>;
}
```

#### `PlaceSpreadOrderParams`

```ts
export type SpreadSide = 'ENTRY' | 'EXIT';

export interface SpreadLeg {
  option_symbol: string;
  side: 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';
  quantity: number;  // always 1 in v1
}

export interface PlaceSpreadOrderParams {
  symbol: string;           // 'SPY'
  side: SpreadSide;         // ENTRY or EXIT
  limit_price: number;
  legs: [SpreadLeg, SpreadLeg];  // exactly 2 legs
  tag: string;              // 'SAS_ENTRY' or 'SAS_EXIT'
}
```

#### `BrokerPosition` (for reconciliation only)

```ts
export interface BrokerPosition {
  symbol: string;
  quantity: number;
  cost_basis: number | null;
  // Additional fields as needed for reconciliation, not core logic.
}
```

---

## 4. Core Metrics & Scoring Interfaces

### 4.1 Candidate Metrics Input

This is the full metric set used to score a candidate spread.

```ts
export interface CandidateMetrics {
  symbol: string;
  expiration: string;

  short_strike: number;
  long_strike: number;
  width: number;

  credit: number;

  ivr: number;
  rv_30d: number;
  iv_30d: number;

  vertical_skew: number;
  term_structure: number;

  delta_short: number;

  // EV inputs:
  pop: number;
  max_profit: number;
  max_loss: number;
}
```

### 4.2 Scoring Result

```ts
export interface ScoringResult {
  ivr_score: number;                // 0–1
  vertical_skew_score: number;      // 0–1
  term_structure_score: number;     // 0–1
  delta_fitness_score: number;      // 0–1
  ev_score: number;                 // 0–1

  composite_score: number;          // 0–1

  ev: number;                       // raw expected value
  pop: number;                      // 0–1
}
```

### 4.3 Core Functions

In `core/metrics.ts`:

```ts
export function computeDTE(expiration: string, now: Date): number;

export function computeIVR(params: {
  iv_now: number;
  iv_min_52w: number;
  iv_max_52w: number;
}): number;

export function computeVerticalSkew(params: {
  iv_short: number;
  iv_long: number;
}): number;

export function computeTermStructure(params: {
  front_iv: number;
  back_iv: number;
}): number;

export function computePOP(delta_short: number): number;

export function computeEV(params: {
  pop: number;
  credit: number;
  width: number;
}): number;
```

In `core/scoring.ts`:

```ts
export function scoreCandidate(
  metrics: CandidateMetrics
): ScoringResult;
```

---

## 5. Risk Management Interfaces

In `core/risk.ts`:

```ts
export type SystemMode = 'NORMAL' | 'HARD_STOP';
export type RiskStateFlag =
  | 'NORMAL'
  | 'DAILY_STOP_HIT'
  | 'PREMARKET_CHECK_FAILED'
  | 'BROKER_RATE_LIMITED'
  | 'EMERGENCY_EXIT_OCCURRED_TODAY';

export interface RiskSnapshot {
  system_mode: SystemMode;
  risk_state: RiskStateFlag;
  daily_realized_pnl: number;
  emergency_exit_count_today: number;
}
```

### 5.1 Risk Functions

```ts
export async function getRiskSnapshot(env: Env, now: Date): Promise<RiskSnapshot>;

export async function canOpenNewTrade(
  env: Env,
  now: Date
): Promise<boolean>;

export async function recordTradeClosed(
  env: Env,
  trade: TradeRow
): Promise<void>;

export async function incrementEmergencyExitCount(
  env: Env,
  now: Date
): Promise<void>;

export async function applyDailyLossCheck(
  env: Env,
  now: Date
): Promise<void>;
```

All risk decisions must flow through these functions or any additional ones defined here, not ad-hoc code.

---

## 6. Engine Interfaces

### 6.1 Proposal Engine (`engine/proposals.ts`)

```ts
export interface ProposalCandidate {
  symbol: string;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  credit: number;

  metrics: CandidateMetrics;
  scoring: ScoringResult;
}

export interface ProposalResult {
  proposal: ProposalRow | null;  // persisted
  candidate: ProposalCandidate | null;
}
```

Main function:

```ts
export async function generateProposal(
  env: Env,
  now: Date
): Promise<ProposalResult>;
```

* Returns `proposal = null` if no valid candidate found.

---

### 6.2 Entry Engine (`engine/entry.ts`)

```ts
export interface EntryAttemptResult {
  trade: TradeRow | null;
  reason?: string; // for logging if no trade
}

export async function attemptEntryForLatestProposal(
  env: Env,
  now: Date
): Promise<EntryAttemptResult>;
```

Also, for polling:

```ts
export async function checkPendingEntries(
  env: Env,
  now: Date
): Promise<void>;
```

---

### 6.3 Monitoring Engine (`engine/monitoring.ts`)

```ts
export interface LiveLegQuotes {
  short_bid: number;
  short_ask: number;
  long_bid: number;
  long_ask: number;
  delta_short: number;
  iv_short: number;
  iv_long: number;
}

export interface MonitoringMetrics {
  current_mark: number;
  unrealized_pnl: number;
  pnl_fraction: number;
  loss_fraction: number;
  dte: number;

  underlying_price: number;
  underlying_change_1m: number;
  underlying_change_15s: number;

  liquidity_ok: boolean;
  quote_integrity_ok: boolean;
}

export type ExitTriggerType =
  | 'NONE'
  | 'EMERGENCY'
  | 'STOP_LOSS'
  | 'PROFIT_TARGET'
  | 'TIME_EXIT';

export interface MonitoringDecision {
  trigger: ExitTriggerType;
  metrics: MonitoringMetrics;
}
```

Main function:

```ts
export async function evaluateOpenTrade(
  env: Env,
  trade: TradeRow,
  now: Date
): Promise<MonitoringDecision>;
```

---

### 6.4 Exit Engine (`engine/exits.ts`)

```ts
export interface ExitExecutionResult {
  trade: TradeRow;
  trigger: ExitTriggerType;
  success: boolean;
  reason?: string;
}

export async function executeExitForTrade(
  env: Env,
  trade: TradeRow,
  decision: MonitoringDecision,
  now: Date
): Promise<ExitExecutionResult>;
```

Also, for polling pending closes:

```ts
export async function checkPendingExits(
  env: Env,
  now: Date
): Promise<void>;
```

---

### 6.5 Lifecycle Utilities (`engine/lifecycle.ts`)

Helper functions to manipulate trade state safely:

```ts
export async function markTradeOpen(
  env: Env,
  tradeId: string,
  entryPrice: number,
  openedAt: Date
): Promise<TradeRow>;

export async function markTradeClosingPending(
  env: Env,
  tradeId: string,
  reason: ExitReason,
  submittedAt: Date,
  brokerOrderId: string
): Promise<TradeRow>;

export async function markTradeClosed(
  env: Env,
  tradeId: string,
  exitPrice: number,
  closedAt: Date
): Promise<TradeRow>;

export async function markTradeCancelled(
  env: Env,
  tradeId: string,
  reason: string
): Promise<TradeRow>;
```

All state transitions should go through these helpers.

---

## 7. Cron Handler Interfaces

In `cron/premarket.ts`:

```ts
export async function runPremarketCheck(env: Env, now: Date): Promise<void>;
```

In `cron/tradeCycle.ts`:

```ts
export async function runTradeCycle(env: Env, now: Date): Promise<void>;
```

In `cron/monitorCycle.ts`:

```ts
export async function runMonitorCycle(env: Env, now: Date): Promise<void>;
```

Worker `scheduled` handler simply calls these based on `event.cron`.

---

## 8. HTTP Handler Interfaces

All HTTP handlers receive:

```ts
type CfRequest = Request;
type CfEnv = Env;
type CfExecutionContext = ExecutionContext;
```

Handlers:

```ts
export async function handleHealth(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response>;

export async function handleStatus(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response>;

export async function handleTrades(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response>;

export async function handleTradeDetail(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  tradeId: string
): Promise<Response>;

export async function handleRiskState(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response>;
```

Router in `index.ts` must use these signatures.

---

## 9. Worker Entrypoint Contract

`src/index.ts` MUST export:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // route to http handlers
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // route to cron handlers
  }
};
```

No other entry signatures are allowed.

---

## 10. Forbidden Interface Drift

Cursor MUST NOT:

* Invent new shapes of `TradeRow` / `ProposalRow` without updating this doc
* Change enum values (`TradeStatus`, `ExitReason`, etc.)
* Add optional fields that change meaning
* Use different types for env variables
* Implement BrokerClient methods with different signatures
* Introduce overlapping interfaces that represent the same concept with slight differences

All core modules must depend on these shared interfaces.

---

# END OF SYSTEM INTERFACES DOCUMENT

This gives Cursor a strict contract:
**what functions exist, what they take, and what they return**.

