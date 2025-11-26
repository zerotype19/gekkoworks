# Phase 2 Closed-Market Verification Checklist

**Time:** 10-20 minutes  
**Goal:** Prove Phase 2 exit integrity works even when markets are closed

---

## 0) Setup Sanity Check

### ✅ Confirm Trading Mode
- [ ] Check `/status` endpoint
- [ ] Verify `trading_mode` is `SANDBOX_PAPER` or `DRY_RUN` (NOT `LIVE`)
- [ ] If `LIVE`, switch to `SANDBOX_PAPER` before testing

### ✅ Confirm Open Trades Exist
- [ ] Call `GET /status` or `GET /trades`
- [ ] Verify `open_positions > 0` or at least one trade with status `OPEN`
- [ ] **If no open trades:** Use `POST /debug/create-test-trade` to create a test trade:
  ```bash
  curl -X POST https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/create-test-trade
  ```
  This creates a test SPY put spread in `OPEN` status (only works in SANDBOX_PAPER or DRY_RUN mode)

**Quick check:**
```bash
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/status | jq '.open_positions'
```

---

## 1) Confirm Exit Rules Are Config-Driven

### Test: View Exit Rules Config

**Call:**
```bash
GET /debug/exit-rules
```

**What to check:**
- [ ] All 7 expected rules are present:
  - `CLOSE_RULE_STOP_LOSS_FRACTION` (should be `-0.50`)
  - `CLOSE_RULE_PROFIT_TARGET_FRACTION` (should be `0.50`)
  - `CLOSE_RULE_TRAILBACK_FRACTION` (should be `0.15`)
  - `CLOSE_RULE_TIME_EXIT_DTE` (should be `2`)
  - `CLOSE_RULE_LOW_VALUE_CLOSE_THRESHOLD` (should be `0.05`)
  - `CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD` (should be `0.30`)
  - `CLOSE_RULE_UNDERLYING_SPIKE_THRESHOLD` (should be `0.005`)
- [ ] `missing_rules` array is empty (or shows which ones are missing)
- [ ] No errors in response

**Expected response:**
```json
{
  "exit_rules": {
    "CLOSE_RULE_STOP_LOSS_FRACTION": "-0.50",
    "CLOSE_RULE_PROFIT_TARGET_FRACTION": "0.50",
    ...
  },
  "missing_rules": [],
  "defaults_used": "All rules configured"
}
```

### Optional Stress Test: Change Config Value

1. [ ] Update a rule in DB (e.g., change profit target to `0.05`):
   ```sql
   UPDATE settings SET value = '0.05' WHERE key = 'CLOSE_RULE_PROFIT_TARGET_FRACTION';
   ```

2. [ ] Call `GET /debug/exit-rules` again
3. [ ] Verify the new value appears in response
4. [ ] **Note:** When markets open, verify this change actually affects exit behavior

**✅ Pass criteria:** All rules loaded from DB, no hardcoded values

---

## 2) Manually Run Monitor Cycle

### Test: Trigger Monitor On-Demand

**Call:**
```bash
GET /debug/monitor
```

**What to look for in logs:**

- [ ] `[monitor][start] runId=...` appears (unique run ID)
- [ ] `[monitor] cycle_start` appears
- [ ] For each open trade: `[monitor][trade] tradeId=... symbol=...`
- [ ] `[data][tradier][quotes]` entries showing quote fetch attempts
- [ ] `[data][tradier][chains]` entries showing option chain fetches
- [ ] `[data][freshness]` entries confirming quotes are fresh
- [ ] `[close] decision` entries for each trade evaluated
- [ ] **NO** `[monitor][error]`, `[data][error]`, or `[db][error]` logs

**Expected log sequence:**
```
[monitor] debug_invoke { source: 'HTTP' }
[monitor][start] { runId: '...', timestamp: '...' }
[monitor] cycle_start { now: '...' }
[monitor] open_trades_scan { count: N }
[monitor][trade] { id: '...', symbol: 'SPY', ... }
[data][tradier][quotes] { symbol: 'SPY', ... }
[data][tradier][chains] { symbol: 'SPY', expiration: '...', count: ... }
[data][freshness] { trade_id: '...', quote_age_ms: 0, ... }
[close] decision { trade_id: '...', trigger: 'NONE', ... }
```

**✅ Pass criteria:** Monitor runs without errors, all trades evaluated, fresh quotes fetched

---

## 3) Test Automatic "Pick One and Close It" Path

### Test: Close Random Open Position

**Call:**
```bash
POST /debug/test-close-position
```

**Expected behavior:**

- [ ] Response shows `success: true`
- [ ] Response includes `trade_id` of the trade being closed
- [ ] Logs show:
  - `[debug][test-close-position] trade_id=...`
  - `[data][tradier][quotes]` (attempts to get real quotes)
  - `[exit][signal] trade_id=...`
  - `[exit][order][sent] trade_id=...` (if in SANDBOX_PAPER)
  - **NO** `[exit][error]` logs

**After exit:**

1. [ ] Call `GET /debug/monitor` again
2. [ ] Verify the closed trade no longer appears in `[monitor][trade]` logs
3. [ ] Check trade status in DB or via `/trades` endpoint:
   ```sql
   SELECT id, status, exit_price, realized_pnl, broker_order_id_close
   FROM trades
   WHERE id = '<trade-id-from-response>';
   ```
4. [ ] Trade should be `CLOSING_PENDING` or `CLOSED` (depending on sync timing)
5. [ ] `broker_order_id_close` should be populated (if in SANDBOX_PAPER)

**✅ Pass criteria:** Full E2E exit pipeline works - trade closed, order sent, DB updated

---

## 4) Force-Exit Specific Trade by ID

### Test: Force Exit Known Trade

**Steps:**

1. [ ] Get an OPEN trade ID:
   ```bash
   GET /trades
   # Find a trade with status: "OPEN"
   # Or check logs from step 2 for trade IDs
   ```

2. [ ] Call force exit:
   ```bash
   POST /debug/force-exit/{trade-id}
   ```

**Expected logs:**

- [ ] `[debug][force-exit] trade_id=...`
- [ ] `[exit][signal] trade_id=... trigger=EMERGENCY`
- [ ] `[exit][order][sent] trade_id=...` (if in SANDBOX_PAPER)
- [ ] **NO** `[exit][error]` logs

**Response should show:**
```json
{
  "success": true,
  "trade_id": "...",
  "trigger": "EMERGENCY",
  "reason": "...",
  "timestamp": "..."
}
```

**After exit:**

1. [ ] Run `GET /debug/monitor` again
2. [ ] Verify that trade is no longer in `[monitor][trade]` logs
3. [ ] Check DB - trade status should be updated

**✅ Pass criteria:** Individual trade can be force-exited, no blockers in exit path

---

## 5) Confirm Monitor + Exits Don't Crash on Missing Data

### Test: Data Integrity Guards

**If comfortable testing this:**

1. [ ] Pick a symbol you're NOT actively trading (e.g., `AAPL` if you only trade `SPY`)
2. [ ] Temporarily break quote data (or just let it be naturally missing)
3. [ ] Run `GET /debug/monitor`

**Expected behavior:**

- [ ] Logs show `[data][missing-field]` for missing data
- [ ] **NO** exit is triggered purely because of missing data
- [ ] **NO** `[monitor][error]` hard crash
- [ ] System gracefully skips that trade or marks it for manual review

**Alternative test (safer):**

- [ ] Just verify logs show proper error handling when quotes fail
- [ ] Check that `[data][missing-field]` logs appear when expected
- [ ] Verify no fake/placeholder values are used in calculations

**✅ Pass criteria:** Missing data is detected, no fake values used, graceful error handling

---

## 6) Confirm Everything Visible from UI

### Test: Quick Links Card

1. [ ] Load dashboard: `https://bb32aa45.gekkoworks-ui.pages.dev`
2. [ ] Find "Quick Links" card
3. [ ] Click each link:
   - [ ] **Exit Rules Config** → Should show JSON with all CLOSE_RULE_* values
   - [ ] **Run Monitor Cycle** → Should return `{ ok: true, ranAt: "..." }`
   - [ ] **DB Health Check** → Should show all checks passing
   - [ ] **System Status** → Should show current system state
   - [ ] **Risk State** → Should show risk snapshot

**✅ Pass criteria:** All endpoints accessible from UI, no manual URL crafting needed

---

## Summary: What You've Proven

After completing this checklist, you've validated:

✅ **Exit rules are config-driven** (no hardcoded values)  
✅ **Monitor cycle runs on demand** (cron heartbeat works)  
✅ **All trades are evaluated** (no skips)  
✅ **Fresh quotes are fetched** (real-time data path works)  
✅ **Exit pipeline is functional** (can close positions E2E)  
✅ **Individual trades can be force-exited** (no blockers)  
✅ **Missing data is handled gracefully** (no crashes, no fake values)  
✅ **UI provides quick access** (admin surface is usable)

---

## What's Left for Live-Market Testing

Once markets open, you only need to test **price-sensitive logic**:

1. [ ] Set tight test exit rules (e.g., `CLOSE_RULE_PROFIT_TARGET_FRACTION = 0.05`)
2. [ ] Open a small PAPER trade via normal flow
3. [ ] Watch logs for:
   - `[monitor][trade]` with that trade
   - `[data][tradier][quotes]` with live prices
   - `[monitor][exit-signal]` when P&L crosses threshold
   - `[exit][order][sent]` immediately in same monitor run
4. [ ] Confirm in Tradier & DB that trade fully closed with correct `realized_pnl`

**If all closed-market tests pass + live-market P&L test passes → Phase 2 is ✅ complete**

---

## Quick Reference: All Debug Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/debug/exit-rules` | GET | View all exit rule config values |
| `/debug/monitor` | GET | Manually trigger monitor cycle |
| `/debug/force-exit/:tradeId` | POST | Force exit specific trade |
| `/debug/test-close-position` | POST | Close random open position |
| `/debug/create-test-trade` | POST | Create test OPEN trade (SANDBOX_PAPER only) |
| `/debug/health/db` | GET | DB health check |
| `/status` | GET | System status with trade breakdown |
| `/trades` | GET | List all trades |

All accessible from Dashboard Quick Links card.

