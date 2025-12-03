# Phase 3: Portfolio-First Engine Alignment

## 1. Target Mental Model (Portfolio-First)

We're standardizing on:

* **Proposals**
  → Find good entries based on strategy rules (IVR, POP, deltas, etc.).
  → They do **not** know or care about broker state.

* **Trades table (`trades`)**
  → Logical "tickets" for managed spreads (symbol + strategy + strikes + expiration + quantity).
  → Tracks: proposal metadata, entry/exit prices, PnL, status, reasons.
  → One trade row per *intentional spread entry*, not per broker leg.

* **Portfolio positions (`portfolio_positions`)**
  → Pure mirror of Tradier positions (per leg).
  → Source of truth for:
    * How many contracts we actually hold (per leg).
    * Whether we are flat or partially flat.
    * Cost basis & mark-based PnL (for portfolio-level views).

* **Order state (via `orderSync`)**
  → Mirrors Tradier orders into whatever structure we use.
  → Drives transitions like ENTRY_PENDING → OPEN and CLOSING_PENDING → CLOSED.

**Key rule going forward:**

* **Entries & exits are *decided* at the trade level**,
  but **quantities & "are we flat?" are determined from `portfolio_positions`**, not from the `trades` table.

---

## 2. Crons – Desired Behavior

### 2.1 `monitorCycle.ts` – Exit Brain + Safety Checks

**Role:**
Keep our view of the world fresh **enough** to make exit decisions, then:
* Repair portfolio if needed.
* Close phantom trades.
* Evaluate exit rules.
* Fire exits.

**Desired flow (high level):**

1. **Sync from broker:**
   * `syncPortfolioFromTradier` → update `portfolio_positions` (legs only, no side-effects on trades).
   * `syncOrdersFromTradier` → update order state; may trigger lifecycle changes (ENTRY_PENDING → OPEN, CLOSING_PENDING → CLOSED).
   * `syncBalancesFromTradier` → update balances and freshness timestamps (for risk, but not strictly required for exits).

2. **Repair & reconcile:**
   * `repairPortfolio(env, now)`:
     * Validate structural invariants between `trades` and `portfolio_positions` (like you're doing in `validateSpreadInvariants`).
     * Mark structurally broken trades as `INVALID_STRUCTURE` or similar.
   * `closePhantomTrades(env, runId, now)`:
     * For each OPEN trade, check `portfolio_positions`:
       * Both legs qty = 0 → close via `markTradeClosedWithReason(..., exitReason='BROKER_ALREADY_FLAT', exitPrice=null, realized_pnl=null)`.
       * Legs out of sync → log warning & leave OPEN.
     * For ENTRY/CLOSING_PENDING trades → deal with stale / no-order-id cases using order status, as you're already doing.

3. **Check pending entries & exits:**
   * `checkPendingEntries` – use order status to flip ENTRY_PENDING → OPEN and call `markTradeOpen` when filled.
   * `checkPendingExits` – use order status to flip CLOSING_PENDING → CLOSED and call `markTradeClosedWithReason` when filled.

4. **Monitor OPEN trades:**
   * Get `openTrades = getOpenTrades(env)` (managed=1).
   * For each trade:
     * Skip if phantom (no entry_price + no broker_order_id_open).
     * Call `evaluateOpenTrade(env, trade, now)`.
       * Uses **quotes** (not portfolio) to compute mark, PnL fraction, DTE, etc.
       * Quantity for PnL metrics comes from `trade.quantity` (or default), not from portfolio.
     * If `decision.trigger !== 'NONE'`:
       * Call `executeExitForTrade(env, trade, decision, now)`:
         * This function uses **`portfolio_positions`** to decide exit quantities and build the exit order.
         * It should not trust `trades.quantity` for actual exit quantity, only as a sanity check / max cap.

5. **Set monitor heartbeat:**
   * Update `LAST_MONITOR_RUN` on successful completion.

---

### 2.2 `accountSync.ts` – Account Snapshot + Freshness

**Role:**
Keep **account-level** metrics up to date for dashboarding and guardrails, *separate from trade lifecycle*.

**Desired flow:**

1. Run periodically (e.g., every minute during market hours).

2. **Sync everything for freshness:**
   * Call:
     * `syncPortfolioFromTradier`
     * `syncOrdersFromTradier`
     * `syncBalancesFromTradier`
   * These maintain internal freshness timestamps and keep `portfolio_positions`, orders, and balances in sync.

3. **Fetch live broker data for snapshot:**
   * `getPositions` (again, directly) to compute open positions & unrealized PnL.
   * `getGainLoss({ start: etDate, end: etDate })` for realized PnL and trades closed today.

4. **Insert `account_snapshot`:**
   * Use `balances` + computed `unrealized_open` + `realized_today`.
   * No lifecycle changes here; this is read-only from the engine's perspective.

---

### 2.3 `tradeCycle.ts` – Proposal → Entry Pipeline

**Role:**
Run proposals, apply risk & concentration rules, and **place entries**.

**Desired flow:**

1. **Generate proposals** via `proposals.ts` (no change in logic).

2. **Apply filters / scoring:**
   * Strategy-specific scoring.
   * Notional/risk limits.
   * Concentration limits:
     * `MAX_SPREADS_PER_SYMBOL`
     * `MAX_QTY_PER_SYMBOL_PER_SIDE`
     * Duplicate spread detection.

3. **Place orders via `TradierClient.placeSpreadOrder`:**
   * Class = `multileg`
   * Type = `credit/debit` based on strategy & ENTRY side (already implemented).

4. **Insert trades:**
   * `insertTrade` with:
     * `status='ENTRY_PENDING'`
     * `broker_order_id_open` set to order ID
     * `quantity` = spread size (contracts per leg)
     * `managed=1`, `origin='ENGINE'`.

5. **No reliance on `portfolio_positions` at entry time.**

---

## 3. Engine Files – Desired Behavior

### 3.1 `proposals.ts`

* **Keep as-is conceptually.**
* Responsibilities:
  * Use IVR/POP/delta/spacing rules to propose spreads.
  * Know nothing about existing positions.
* Only dependency on the rest of the system:
  * Optional: global risk settings (max trades/day, allowed strategies, etc.)

**Cursor questions / checks:**
* Confirm `proposals.ts`:
  * Does not read `trades` for PnL or state.
  * Does not read `portfolio_positions`.
  * Only depends on market data + global config.

---

### 3.2 `entry.ts`

* Role:
  * Take a **validated proposal** and turn it into:
    1. A Tradier multileg order (via `placeSpreadOrder`).
    2. A `trades` record with `status='ENTRY_PENDING'`.

* Rules:
  * Must set:
    * `strategy`, `symbol`, `expiration`, `short_strike`, `long_strike`, `width`
    * `quantity` per spread (this is the logical "ticket size").
    * `broker_order_id_open` from Tradier response.
    * `origin='ENGINE'`, `managed=1`.
  * Must **not** inspect `portfolio_positions` (that's for risk layer and exits/monitoring).

**Cursor checks:**
1. Show where `placeSpreadOrder` is called and confirm:
   * `params.strategy` is always set (no "strategy is required" throw).
   * `params.side` is `ENTRY`.
2. Confirm `insertTrade`:
   * Always sets `managed=1` for engine-created trades.
   * Correctly stores `quantity` per spread, not per leg.
3. Confirm `entry.ts` doesn't alter `portfolio_positions`.

---

### 3.3 `exits.ts`

* Role:
  * Take an **exit decision** and execute it, using **portfolio state** to decide quantities.

* Desired rules:

1. **computeAvailableQuantities(env, trade)**:
   * Uses `getSpreadLegPositions` → `portfolio_positions` to get `shortLeg` and `longLeg`.
   * Converts to a `spread position snapshot`:
     * `shortQty`, `longQty`, signs appropriate to direction.
   * Returns:
     * `available_exit_qty = min(abs(shortQty), abs(longQty))`.
   * Uses `trade.quantity` only as a **max cap**:
     * If `available_exit_qty > trade.quantity`, log a warning and cap to `trade.quantity`.

2. **resolveExitQuantity(env, trade, decision)**:
   * Uses the above snapshot to choose exit size.
   * Error cases:
     * Both legs zero → `BROKER_ALREADY_FLAT` (should route to phantom close path).
     * One leg zero, other > 0 → `SPREAD_LEGS_OUT_OF_SYNC` (log + no exit).

3. **executeExitForTrade(env, trade, decision, now)**:
   * Uses `resolveExitQuantity` to determine `exitQty`.
   * Builds EXIT multileg order:
     * `params.side = 'EXIT'`
     * Leg sides must be *_to_close.
   * Calls `placeSpreadOrder` with correct type (credit/debit flipped on EXIT).
   * On success:
     * Update trade to `CLOSING_PENDING`.
     * Store `broker_order_id_close`.

**Cursor checks:**
* Show the current implementations of:
  * `computeAvailableQuantities`
  * `resolveExitQuantity`
  * `executeExitForTrade`
* Confirm:
  * All three now derive quantities from `portfolio_positions`.
  * None of them rely solely on `trades.quantity` for actual order sizing.
  * EXIT orders always use `_to_close` sides and `params.side='EXIT'`.

---

### 3.4 `lifecycle.ts`

You already shared this file; we want to align it with the new portfolio-first behavior.

**Keep:**
* `markTradeOpen`:
  * Uses `entryPrice` (net credit/debit per contract) to set:
    * `entry_price`, `opened_at`, `max_profit`, `max_loss`, `iv_entry`.
  * Runs `validateSpreadInvariants` (good).

* `validateSpreadInvariants`:
  * Uses `getOptionChain` + `getPositions` to ensure:
    * Correct strike relationships.
    * Both legs present.
    * Quantity & direction signs make sense.

* `markTradeClosingPending`:
  * Sets `status='CLOSING_PENDING'` and `broker_order_id_close`.

* `markTradeCancelled`:
  * Sets `status='CANCELLED'` + logs free-text reason.

**Add/Adjust:**
* Introduce `markTradeClosedWithReason` as described in my previous message:
  * Accepts `exitReason` and optional `realizedPnlOverride`.
  * Computes PnL only when `exitPrice` and `entry_price` are known and we're doing a normal exit.
  * Allows phantom closes to set `exit_price=null`, `realized_pnl=null`.

* Ensure **only** `orderSync` + `monitorCycle` call these lifecycle helpers; no random direct status mutations elsewhere.

**Cursor checks:**
1. Confirm:
   * `markTradeOpen` is called **only** in response to a filled ENTRY order (from orderSync).
   * `markTradeClosed`/`markTradeClosedWithReason` are called **only** in response to:
     * Filled exits (`CLOSING_PENDING` → `CLOSED`).
     * Phantom close logic (`BROKER_ALREADY_FLAT`, etc.).
2. Verify:
   * `validateSpreadInvariants` is used only after opening a spread (not randomly).
3. Implement `markTradeClosedWithReason` and update call sites (esp. phantom close) to use it.

---

### 3.5 `monitoring.ts`

* Role:
  * Given a trade and **current market data**, decide if an exit trigger should fire.

**Desired rules:**
* Inputs:
  * `trade` (from `trades`).
  * Current time.
  * Live quotes (underlying + options) from Tradier.

* Outputs:
  * `decision.trigger` ∈ { 'NONE', 'PROFIT_TARGET', 'STOP_LOSS', 'TIME_EXIT', 'EMERGENCY', ... }
  * `decision.metrics`:
    * `current_mark` (per-contract spread value).
    * `unrealized_pnl` and `pnl_fraction` based on `trade.entry_price` and `trade.quantity`.
    * `dte`, underlying change, etc.

* It **does not**:
  * Look at `portfolio_positions` or actual fills.
  * Change any status or touch lifecycle.

**Cursor checks:**
* Confirm:
  * `evaluateOpenTrade` only uses quotes + trade metadata, not portfolio.
  * PnL math uses `trade.entry_price` and `trade.quantity`.
* Confirm triggers line up with your latest rule thresholds (profit %, stop %, DTE, etc.).

---

### 3.6 `orderSync.ts`

* Role:
  * Mirror broker orders and update trade lifecycle based on status.

**Desired behavior:**
1. Fetch orders from Tradier (`getAllOrders` / `getOpenOrders`).
2. For each trade with `broker_order_id_open` or `broker_order_id_close`:
   * Map to the corresponding broker order.
   * If ENTRY order becomes FILLED:
     * Call `markTradeOpen(env, trade.id, avg_fill_price, filledAt, ivEntry?)`.
   * If EXIT order becomes FILLED:
     * Call `markTradeClosedWithReason(env, trade.id, exitPrice, closedAt, trade.exit_reason || 'NORMAL_EXIT')`.
   * If orders are REJECTED/CANCELLED/EXPIRED:
     * Use clear rules to:
       * Keep trade OPEN (no change), or
       * Mark trade as `CANCELLED` or `EXIT_ERROR`, depending on context.

**Cursor checks:**
* Show exactly where:
  * ENTRY fills → `markTradeOpen`.
  * EXIT fills → `markTradeClosed` / `markTradeClosedWithReason`.
* Confirm:
  * `avg_fill_price` normalization logic is consistent with `TradierClient` (credit/debit sign handling).
  * `orderSync` does **not** write to `portfolio_positions` (that's `portfolioSync` only).

---

### 3.7 `portfolioSync.ts`

You already refactored this pretty cleanly, but let's make the contract explicit.

**Role:**
Purely mirror Tradier **positions** into `portfolio_positions`.

**Contract:**
* One row per option leg (symbol + expiration + type + strike + side).
* Fields include:
  * `quantity` (signed or absolute as you defined; just be consistent with `computeSpreadPositionSnapshot`).
  * `cost_basis_per_contract` (if available).
  * `updated_at`.
* No trades created, updated, or touched.
* Sync procedure:
  * Upsert current legs.
  * Delete rows in `portfolio_positions` that are not present in the latest broker positions.

**Cursor checks:**
* Confirm no remaining logic that:
  * Creates trades from positions.
  * Labels trades as phantom from within `portfolioSync` itself.
* Make sure the deletion logic is correct for SQLite (no tuple `NOT IN` issues).

---

## 4. Concrete Checklist for Cursor

### CRON + ENGINE ALIGNMENT – TASKS FOR CURSOR

**Overall goal:**
Align `monitorCycle.ts`, `accountSync.ts`, and `tradeCycle.ts` with a **portfolio-first** engine where:
* Proposals drive entries.
* `portfolio_positions` mirrors Tradier.
* Exits are driven by **positions + exit rules**, not per-trade order history.

**Implementation order (do not skip steps):**

1. Complete checklist items for `portfolioSync.ts` (Section 6).
2. Complete checklist items for `orderSync.ts` (Section 5).
3. Complete checklist items for `lifecycle.ts` and `monitorCycle.ts` phantom handling (Section 3).
4. Complete checklist items for `exits.ts` and `monitoring.ts` (Sections 2 and 4).
5. Validate `proposals.ts` and `entry.ts` (Section 1) and fix any violations.
6. Run manual tests described in the Test Plan.

---

#### 1) Validate Proposals + Entry Path

* [ ] In `proposals.ts`, confirm:
  * It does **not** read from `trades` or `portfolio_positions`.
  * It only uses market data + config to rank candidates.

* [ ] In `entry.ts` (or wherever entries are executed):
  * Show all call sites of `placeSpreadOrder`.
  * Confirm `params.strategy` and `params.side='ENTRY'` are always set.
  * Confirm `insertTrade` is always called with:
    * `status='ENTRY_PENDING'`
    * `broker_order_id_open` = returned order ID
    * `quantity` = contracts per spread
    * `origin='ENGINE'`, `managed=1`.

---

#### 2) Enforce Portfolio-First Exits

* [ ] In `exits.ts`:
  * Show `computeAvailableQuantities`, `resolveExitQuantity`, and `executeExitForTrade`.
  * Confirm:
    * They derive quantities from `portfolio_positions` via `getSpreadLegPositions` + `computeSpreadPositionSnapshot`.
    * `trade.quantity` is used only as an upper bound / sanity check.
    * Error cases:
      * Both legs zero → `BROKER_ALREADY_FLAT`.
      * One leg zero, other > 0 → `SPREAD_LEGS_OUT_OF_SYNC`.

* [ ] Ensure EXIT orders:
  * Use `params.side='EXIT'`.
  * All legs are *_to_close in `placeSpreadOrder`.
  * Order type (credit/debit) is flipped vs. ENTRY based on strategy.

---

#### 3) Lifecycle Helpers and Phantom Closes

* [ ] Implement `markTradeClosedWithReason` in `lifecycle.ts`:

  ```ts
  export async function markTradeClosedWithReason(
    env: Env,
    tradeId: string,
    exitPrice: number | null,
    closedAt: Date,
    exitReason: ExitReason,
    realizedPnlOverride?: number | null
  ): Promise<TradeRow>;
  ```

  * If `realizedPnlOverride` is provided, use it.
  * Else if `exitPrice` and `entry_price` exist, compute PnL with debit/credit logic.
  * Else set `realized_pnl = null`.
  * Always set `status='CLOSED'`, `exit_price`, `exit_reason`, `closed_at`.

* [ ] Update the existing `markTradeClosed` to be a thin wrapper for normal exits:

  ```ts
  export async function markTradeClosed(
    env: Env,
    tradeId: string,
    exitPrice: number,
    closedAt: Date
  ): Promise<TradeRow> {
    return markTradeClosedWithReason(env, tradeId, exitPrice, closedAt, 'NORMAL_EXIT');
  }
  ```

* [ ] In `monitorCycle.ts` → `closePhantomTrades`:
  * For Rule A (both legs zero), replace any direct `markTradeClosed` calls with:

    ```ts
    const closed = await markTradeClosedWithReason(
      env,
      trade.id,
      null,
      now,
      'BROKER_ALREADY_FLAT',
      null
    );
    await recordTradeClosed(env, closed);
    ```

  * Ensure other reconciliation cases (stale ENTRY_PENDING/CLOSING_PENDING) also use `markTradeClosedWithReason` or `updateTrade` with:
    * `status='CLOSED'` or `status='CANCELLED'`
    * `exit_reason='MANUAL_CLOSE'` or `'UNKNOWN'`
    * `realized_pnl=null` (never fabricate max profit/max loss for phantom scenarios).

---

#### 4) Monitoring vs. Positions – Keep Separation of Concerns

* [ ] In `monitoring.ts`:
  * Confirm `evaluateOpenTrade`:
    * Uses only quotes + trade metadata (no portfolio).
    * Uses `trade.entry_price` + `trade.quantity` to compute PnL metrics.

* [ ] In `monitorCycle.ts`:
  * Confirm the flow is:
    * Sync (positions, orders, balances).
    * `repairPortfolio`.
    * `closePhantomTrades`.
    * `checkPendingEntries` and `checkPendingExits`.
    * Loop through `getOpenTrades` and call `evaluateOpenTrade` + `executeExitForTrade`.

---

#### 5) Order Sync Rules

* [ ] In `orderSync.ts`:
  * Show where:
    * ENTRY fills call `markTradeOpen`.
    * EXIT fills call `markTradeClosed` / `markTradeClosedWithReason`.
  * Confirm:
    * `avg_fill_price` is correctly normalized (credit/debit sign).
    * `orderSync` does **not** write to `portfolio_positions`.

---

#### 6) Portfolio Sync Contract

* [ ] In `portfolioSync.ts`:
  * Confirm:
    * It only mirrors Tradier positions → `portfolio_positions`.
    * It no longer creates or modifies trades.
    * Deletes any `portfolio_positions` rows not returned by the latest broker positions.
  * Confirm the schema is consistent with what `getSpreadLegPositions` expects.

---

## Success Criteria

After completing this checklist, the system should have:

* ✅ Proposals still hunting for good entries (unchanged).
* ✅ A clean separation of **trades vs. positions vs. orders**.
* ✅ Exits that use **real portfolio state**, not "one-trade-at-a-time" assumptions.
* ✅ Phantom closes that don't fabricate PnL.
* ✅ Lifecycle helpers that support both normal exits and reconciliation scenarios.

From there, we can layer on smarter multi-trade aggregation (per symbol/expiration/strike) for exits, but the core engine will be sound.

---

## 5. Minimal Test Plan (Required)

After making the changes above, Cursor must run and log the following tests (in SANDBOX_PAPER):

### Test 1: Simple New Spread → Open → Exit Path

* Open 1× BULL_CALL_DEBIT spread.
* Verify:
  * `trades` row created with `status='ENTRY_PENDING'`, `managed=1`, `origin='ENGINE'`.
  * `portfolio_positions` has 2 legs with correct strikes, sides, and quantity.
  * When the order fills, `orderSync` calls `markTradeOpen`, status becomes `OPEN` with correct `entry_price`.
  * When monitor decides to close, `executeExitForTrade` uses `portfolio_positions` quantity, sends an EXIT multileg order, and the trade ends as `CLOSED` via `markTradeClosedWithReason('NORMAL_EXIT')` with non-null `realized_pnl`.

### Test 2: Phantom-Close Scenario

* Manually close the spread in Tradier UI (so broker is flat but `trades.status='OPEN'`).
* Run monitor. Verify:
  * `portfolio_positions` legs go to quantity 0.
  * `closePhantomTrades` calls `markTradeClosedWithReason` with `exitReason='BROKER_ALREADY_FLAT'`, `exit_price=null`, `realized_pnl=null`.
  * Trade status is `CLOSED`, not `EXIT_ERROR`.

### Test 3: Legs Out of Sync Scenario

* Simulate a state where one leg is qty 1 and the other qty 0.
* Run monitor. Verify:
  * Trade remains `OPEN`.
  * Log line with `[monitorCycle][legs-out-of-sync]` and snapshot of mismatched quantities.

### Test 4: Assertion: Proposals Ignore Portfolio

* Verify via code search and/or logs that `proposals.ts` never imports or calls any `db/queries` functions related to `trades` or `portfolio_positions`.

