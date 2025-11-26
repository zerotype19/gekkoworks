# Debug Endpoints Testing Guide

Complete guide for testing the exit system **even when markets are closed**.

## Available Debug Endpoints

### 1. **Monitor Cycle** (GET)
**Endpoint:** `/debug/monitor`

Manually triggers a full monitor cycle (same as cron).

**What it tests:**
- Monitor cron heartbeat
- All OPEN trades are evaluated
- Fresh quotes are fetched from Tradier
- Exit rule evaluation runs

**Expected logs:**
```
[monitor] debug_invoke
[monitor][start] runId=...
[monitor] cycle_start
[monitor][trade] (for each open trade)
[close] decision (for each trade)
```

---

### 2. **DB Health Check** (GET)
**Endpoint:** `/debug/health/db`

Validates database connectivity and shows trade counts.

**What it tests:**
- D1 database is accessible
- Latest SPY quote from Tradier
- Trade counts by status
- Settings table (including exit rules)

**Response includes:**
- `checks.quote_spy` - Latest Tradier quote
- `checks.trades_by_status` - Counts by status
- `checks.open_trades` - Open trade count
- `checks.settings` - All CLOSE_RULE_* settings

---

### 3. **Exit Rules Config** (GET)
**Endpoint:** `/debug/exit-rules`

Shows all exit rule thresholds loaded from database.

**What it tests:**
- Config-driven exit rules are loaded
- No hardcoded values remain
- All expected rules are present

**Response includes:**
- `exit_rules` - All CLOSE_RULE_* key/value pairs
- `missing_rules` - Any rules not configured (will use defaults)

**Expected rules:**
- `CLOSE_RULE_STOP_LOSS_FRACTION` (default: -0.50)
- `CLOSE_RULE_PROFIT_TARGET_FRACTION` (default: 0.50)
- `CLOSE_RULE_TRAILBACK_FRACTION` (default: 0.15)
- `CLOSE_RULE_TIME_EXIT_DTE` (default: 2)
- `CLOSE_RULE_LOW_VALUE_CLOSE_THRESHOLD` (default: 0.05)
- `CLOSE_RULE_LIQUIDITY_SPREAD_THRESHOLD` (default: 0.30)
- `CLOSE_RULE_UNDERLYING_SPIKE_THRESHOLD` (default: 0.005)

---

### 4. **Force Exit** (POST)
**Endpoint:** `/debug/force-exit/:tradeId`

Bypasses exit rule logic and immediately triggers exit for a specific trade.

**What it tests:**
- Exit execution pipeline
- Order building logic
- Tradier API integration
- Database state updates

**Usage:**
```bash
POST /debug/force-exit/abc-123-trade-id
```

**Expected logs:**
```
[debug][force-exit] trade_id=...
[exit][signal] trade_id=...
[exit][order][sent] trade_id=...
```

**Response:**
- `success: true/false`
- `trigger: "EMERGENCY"`
- `reason: "..."`

---

### 5. **Test Close Position** (POST)
**Endpoint:** `/debug/test-close-position`

Finds a random open PAPER position and attempts to close it directly.

**What it tests:**
- Full exit → Tradier → DB pipeline
- Order submission works after hours (PAPER mode)
- Real quotes are fetched and used
- Trade state transitions correctly

**Usage:**
```bash
POST /debug/test-close-position
```

**Expected logs:**
```
[debug][test-close-position] trade_id=...
[data][tradier][quotes] ...
[data][tradier][chains] ...
[exit][signal] ...
[exit][order][sent] ...
```

**Response:**
- `success: true/false`
- `trade_id: "..."`
- `symbol: "SPY"`
- `trigger: "EMERGENCY"`

**Note:** Only works in `SANDBOX_PAPER` or `DRY_RUN` mode (disabled in LIVE).

---

## Testing Checklist (Markets Closed)

### ✅ Test 1: Monitor Engine Runs
1. Call `GET /debug/monitor`
2. Check logs for `[monitor][start]` with unique runId
3. Verify `[monitor][trade]` appears for each open trade
4. Confirm no errors in logs

### ✅ Test 2: Real-Time Quote Calls
1. Call `GET /debug/health/db`
2. Verify `checks.quote_spy.ok === true`
3. Check for `[data][tradier][quotes]` in logs
4. No `[data][missing-field]` or `[data][error]` logs

### ✅ Test 3: Exit Rules Loaded from DB
1. Call `GET /debug/exit-rules`
2. Verify all 7 expected rules are present
3. Change a value in DB (e.g., `CLOSE_RULE_PROFIT_TARGET_FRACTION = 0.05`)
4. Call `GET /debug/monitor`
5. Verify logs show the new config value being used

### ✅ Test 4: Force Exit Signal
1. Get an open trade ID from `/trades`
2. Call `POST /debug/force-exit/:tradeId`
3. Check logs for:
   - `[debug][force-exit]`
   - `[exit][signal]`
   - `[exit][order][sent]` (if in SANDBOX_PAPER)
4. Verify trade status updated in DB

### ✅ Test 5: Test Close Position
1. Ensure you have at least one OPEN trade
2. Call `POST /debug/test-close-position`
3. Verify:
   - Real quotes are fetched
   - Exit order is built correctly
   - Tradier API call succeeds (PAPER mode)
   - Trade state transitions

### ✅ Test 6: Quote Freshness Guards
1. Call `GET /debug/monitor`
2. Check logs for `[data][freshness]` entries
3. Verify `quote_age_ms: 0` (quotes just fetched)
4. No `[data][stale-quote]` warnings

### ✅ Test 7: Time-Exit Logic
1. Get a trade with known expiration
2. Set `CLOSE_RULE_TIME_EXIT_DTE = 999` (should not exit)
3. Call `GET /debug/monitor`
4. Set `CLOSE_RULE_TIME_EXIT_DTE = 0` (should exit if DTE <= 0)
5. Call `GET /debug/monitor` again
6. Verify exit signal when DTE threshold met

### ✅ Test 8: No Hardcoded Values
1. Call `GET /debug/exit-rules`
2. Verify all thresholds come from DB
3. Search codebase for numeric literals in exit evaluation
4. Confirm all use `getSetting(env, 'CLOSE_RULE_*')`

---

## Most Important Test: Force-Exit

**The gold-standard test when markets are closed:**

1. Get an open trade ID:
   ```bash
   GET /trades
   # Find a trade with status: "OPEN"
   ```

2. Force exit it:
   ```bash
   POST /debug/force-exit/{trade-id}
   ```

3. Watch logs for complete flow:
   ```
   [debug][force-exit] trade_id=...
   [exit][signal] trade_id=...
   [exit][order][sent] trade_id=...
   [tradier][response] {...}
   ```

**If this works without errors → entire exit pipeline is functional.**

---

## Quick Access from UI

The Dashboard now includes a "Quick Links" card with one-click access to:
- 📊 System Status
- 🏥 DB Health Check
- ⚙️ Exit Rules Config
- 🔄 Run Monitor Cycle
- ❤️ Health Endpoint
- ⚠️ Risk State
- 📡 Broker Events

All endpoints open in new tabs for quick monitoring and debugging.

---

## Notes

- All debug endpoints work **even when markets are closed**
- PAPER mode allows order submission after hours
- DRY_RUN mode logs but doesn't place orders
- LIVE mode disables some debug endpoints for safety

