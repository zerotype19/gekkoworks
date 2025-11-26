# 📘 `/docs/cursor-implementation-brief.md`

**SAS v1 — Cursor Implementation Brief**
**Status: Absolute Rules (NON-NEGOTIABLE)**

This document defines *how Cursor must behave* when implementing the SAS v1 system.

Cursor MUST follow this brief for every commit, refactor, or new file.

Cursor MUST NOT deviate from this brief unless the brief itself is updated.

This is the operating contract between you and Cursor.

---

# ✳️ 1. Absolute Starting Rule

> **Cursor MUST read ALL files in `/docs/` before beginning ANY implementation.**

These documents define the constitution of SAS:

* System Philosophy
* Strategy Engine
* Scoring Model
* Proposal Generation
* Entry Rules
* Execution Rules
* Exit Rules
* Monitoring
* Risk Management
* Broker Rules
* Architecture
* Order Lifecycle
* Testing & Validation
* Setup
* System Interfaces (Type Contracts)
* This Implementation Brief

Cursor must reference these constantly.
If any conflict arises, the `/docs/` specification always wins.

---

# ✳️ 2. Zero Creativity Policy

Cursor MUST NOT:

* invent new behavior
* interpret rules loosely
* add features not in spec
* “optimize” architecture
* “simplify” types
* use shortcuts
* skip risk gates
* invent new DB fields
* change function signatures
* assume missing information
* import unused libraries
* reorganize file structure

If something is unclear → ASK for clarification.
Never guess.

---

# ✳️ 3. Repo Structure (Non-Negotiable)

Cursor MUST implement code exactly within this structure:

```
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
  ...
```

Cursor MUST NOT move or rename these without explicit instruction.

---

# ✳️ 4. DB Schema Rules

Cursor MUST:

* use `/worker/src/db/schema.sql` as the single source of truth
* never add columns without explicit instruction
* never remove or rename columns
* always use the types defined in `/docs/system-interfaces.md`
* use `db/client.ts` + `db/queries.ts` to interact with D1 (no inline SQL elsewhere)

If schema changes are needed → ask first.

---

# ✳️ 5. Implementation Order (MANDATORY)

Cursor MUST implement SAS in **this exact order**:

---

## **Phase 1: Foundation**

1. `env.ts`
2. `types.ts` (interfaces from system-interfaces.md)
3. DB layer:

   * `schema.sql`
   * `client.ts`
   * `queries.ts`
4. Broker layer:

   * `tradierClient.ts` using /docs/broker-rules.md

**No engine logic may be written until the foundation is complete.**

---

## **Phase 2: Core Logic**

In this order:

1. `core/time.ts`
2. `core/metrics.ts`
3. `core/scoring.ts`
4. `core/risk.ts`

These must pass the test vector logic defined in `/docs/testing-and-validation.md`.

---

## **Phase 3: Engines**

Implement in this exact order:

1. `engine/proposals.ts`
2. `engine/entry.ts`
3. `engine/lifecycle.ts` (state transitions)
4. `engine/monitoring.ts`
5. `engine/exits.ts`

Each engine **must match the flow in `/docs/order-lifecycle.md`**.

No skipped steps.
No supplements.
No divergence.

---

## **Phase 4: Crons & Routing**

Implement crons in order:

1. `cron/premarket.ts`
2. `cron/tradeCycle.ts`
3. `cron/monitorCycle.ts`

Then implement Worker entrypoint in `index.ts`:

* route crons according to `/docs/architecture.md`
* route HTTP endpoints
* DO NOT add new HTTP endpoints

---

## **Phase 5: Dry-Run Mode**

Implement DRY-RUN according to `/docs/setup.md`:

* No order placement
* Logging-only entries
* No state transitions except simulated fill states

Cursor must confirm DRY-RUN works before writing sandbox trading logic.

---

## **Phase 6: Sandbox-Paper Mode**

Implement full broker integration:

* Orders placed to Tradier
* Polling logic
* Fill handling
* Exit handling
* Monitoring-driven decisions

Debug until the **full lifecycle simulation** in `/docs/testing-and-validation.md` passes.

---

## **Phase 7: Hardening**

Cursor must:

* Validate risk kill-switch tests
* Validate failure branches
* Validate emergency exits
* Validate all state transitions
* Ensure logs contain no errors or uncaught exceptions

Only then should you deploy.

---

# ✳️ 6. Error Handling Rules (Non-Negotiable)

Cursor MUST:

* Throw errors when specs are violated
* Log all broker errors
* Never swallow exceptions silently
* Mark trades cancelled when entry fails
* Trigger EMERGENCY exit when required
* Enforce all risk state transitions

Cursor MUST NOT:

* Retry entries
* Widen spreads
* Submit market orders
* invent fallback values for missing quotes
* reconstruct missing Greeks

---

# ✳️ 7. Worker Behavior Requirements

Cursor MUST:

* ensure `fetch` routes only to read-only HTTP handlers
* ensure `scheduled` routes only to cron handlers
* not add background loops
* not use global mutable variables as state
* persist ALL state in D1
* log module name + event for every cycle

---

# ✳️ 8. Monitoring Frequency Behavior

Cloudflare cron limitations mean true 2-second cycles aren’t possible.
Cursor MUST:

* implement monitoring logic so that it can run **multiple times per minute**
* inside the monitoring logic, iterate through all active trades
* evaluate exit triggers per `/docs/exit-rules.md`
* guarantee deterministic behavior even if cycles run ~15–30 seconds apart

This is acceptable and spec-compliant.

---

# ✳️ 9. Forbidden Behaviors (Critical)

Cursor MUST NOT:

* invent strategy code
* add new indicators
* use TA libraries
* use AI or LLM logic inside Worker
* modify scoring weights
* modify calculation formulas
* skip validation checks
* bypass risk
* write hybrid spread orders
* write leg-by-leg orders
* change DTE window
* change allowed symbols
* place multiple spreads per cycle
* scale quantity
* implement margin checks
* build UI state in Worker
* connect to anything except Tradier + Cloudflare D1

EVER.

---

# ✳️ 10. Testing Requirements

Cursor MUST embed testable utility functions where required so manual tests can be run via:

* `wrangler dev`
* dry-run logs
* simulated states

It MUST follow `/docs/testing-and-validation.md` as the test oracle.

---

# ✳️ 11. Ask Before You Deviate

If any part of the implementation requires:

* a new field
* a new function
* a new setting
* a new cron
* a new state
* a modification to architecture
* a database migration

Cursor MUST:

1. Ask for confirmation
2. Wait for explicit approval
3. Only then implement

No exceptions.

---

# ✳️ 12. Primary Directive (Print This Above Cursor’s Terminal)

### **“When in doubt, ask.

Never assume.
Never improvise.
The documents in `/docs/` define the truth.”**

---

# END OF CURSOR IMPLEMENTATION BRIEF

---

