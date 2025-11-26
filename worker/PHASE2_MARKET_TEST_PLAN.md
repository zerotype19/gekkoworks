# Phase 2 Live Market Test Plan

**Purpose:** Validate Phase 2 exit integrity during live market hours.

**Prerequisites:**
- All closed-market tests pass (see `PHASE2_VERIFICATION_CHECKLIST.md`)
- System mode is `NORMAL`
- Exit rules are configured
- At least one test trade exists

---

## Pre-Market Setup (Before 9:30 AM ET)

### 1. Verify System State

```bash
# Check system mode
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/system-mode

# Expected:
# {
#   "system_mode": "NORMAL",
#   "risk_state": "NORMAL",
#   "emergency_exit_count_today": 0
# }
```

**Action if not NORMAL:**
- Use `POST /debug/system-mode` to reset if needed
- Investigate any HARD_STOP reasons

### 2. Verify Exit Rules

```bash
# Check exit rules
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/exit-rules

# Expected: All 7 rules present with test-friendly values
```

**Optional:** Set tight test thresholds:
```sql
UPDATE settings SET value = '0.05' WHERE key = 'CLOSE_RULE_PROFIT_TARGET_FRACTION';
UPDATE settings SET value = '-0.05' WHERE key = 'CLOSE_RULE_STOP_LOSS_FRACTION';
```

### 3. Create Test Trade (if needed)

```bash
# Create a test trade
curl -X POST https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/create-test-trade

# Or use normal proposal → entry flow
```

**Verify:**
- Trade appears in `/trades` with status `OPEN`
- Trade has `entry_price` populated
- Trade has `broker_order_id_open` (managed trade)

---

## During Market Hours (9:30 AM - 4:00 PM ET)

### Test 1: Monitor Cycle Runs

**What to watch:**
- Cloudflare logs for `[monitor][start]` every minute
- `[monitor][trade]` entries for each open trade
- `[data][tradier][quotes]` with live prices
- `[data][freshness]` confirming quotes are fresh

**Expected:**
- Monitor cycle runs every minute
- All managed trades are evaluated
- Fresh quotes are fetched from Tradier
- No `[monitor][error]` logs

**Pass criteria:** ✅ Monitor runs continuously, evaluates all trades, uses fresh data

---

### Test 2: Exit Rule Triggers

**Setup:**
- Have at least one OPEN trade
- Set tight exit thresholds (5% profit/stop) for testing

**What to watch:**
- When P&L crosses threshold, verify:
  - `[monitor][exit-signal]` appears
  - `[exit][signal]` appears with correct trigger
  - `[exit][order][sent]` appears in same monitor cycle
  - No `[system][mode-change]` to HARD_STOP
  - No `[exit][error]` logs

**Expected sequence:**
```
[monitor][trade] { trade_id: "...", pnl_fraction: 0.06 }
[close] decision { trigger: "PROFIT_TARGET", pnl_fraction: 0.06 }
[exit][signal] { trade_id: "...", trigger: "PROFIT_TARGET" }
[exit][order][sent] { trade_id: "...", order_id: "..." }
```

**Pass criteria:** ✅ Exit triggers correctly, order submitted, no HARD_STOP

---

### Test 3: Order Execution

**What to watch:**
- Tradier order status (via `/broker-events` or Tradier UI)
- Trade status transitions: `OPEN → CLOSING_PENDING → CLOSED`
- `realized_pnl` is calculated correctly

**Verify in Tradier:**
- Order appears in Tradier account
- Order fills (or is rejected for valid reasons)
- Position is closed

**Verify in DB:**
```sql
SELECT id, status, exit_price, realized_pnl, broker_order_id_close
FROM trades
WHERE id = '<test-trade-id>';
```

**Expected:**
- `status = 'CLOSED'`
- `exit_price` populated
- `realized_pnl` matches expected value
- `broker_order_id_close` populated

**Pass criteria:** ✅ Order executes, trade closes, P&L is correct

---

### Test 4: After-Hours Behavior

**Test at 4:01 PM ET (after market close):**

**What to watch:**
- Attempt to force exit a trade: `POST /debug/force-exit/:tradeId`
- Verify logs show:
  - `[exit][order][rejected]` with `benign: true`
  - `code: "MARKET_CLOSED"`
  - **NO** `[system][mode-change]` to HARD_STOP
  - **NO** emergency exit triggered

**Expected:**
```json
{
  "success": false,
  "reason": "Market closed: ..."
}
```

**Pass criteria:** ✅ After-hours rejections are benign, no HARD_STOP

---

## Post-Market Verification

### 1. Review Logs

**Check for:**
- ✅ `[monitor][start]` appears every minute
- ✅ `[monitor][trade]` for all managed trades
- ✅ `[data][tradier][quotes]` with live prices
- ✅ `[exit][signal]` when thresholds crossed
- ✅ `[exit][order][sent]` for exit attempts
- ❌ **NO** `[system][mode-change]` to HARD_STOP (unless legitimate)
- ❌ **NO** `[exit][error]` for benign rejections
- ❌ **NO** `[monitor][error]` hard crashes

### 2. Verify Trade States

**Check all trades:**
- Managed trades: Should be `CLOSED` or `OPEN` (not stuck in `CLOSING_PENDING`)
- External trades: Should be skipped (not evaluated)
- No trades stuck in error states

### 3. Verify System State

```bash
# Final system state check
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/status

# Expected:
# {
#   "system_mode": "NORMAL",
#   "risk_state": "NORMAL",
#   "emergency_exit_count_today": 0 (or low number if legitimate)
# }
```

---

## Success Criteria

### Must Pass (Blockers)

- [ ] Monitor cycle runs every minute during market hours
- [ ] Exit rules trigger correctly when P&L crosses thresholds
- [ ] Exit orders are submitted to Tradier successfully
- [ ] Trades transition correctly: `OPEN → CLOSING_PENDING → CLOSED`
- [ ] `realized_pnl` is calculated correctly
- [ ] After-hours rejections are benign (no HARD_STOP)
- [ ] System mode remains `NORMAL` (unless legitimate emergency)

### Should Pass (Warnings)

- [ ] Exit orders fill within expected timeframe
- [ ] No excessive Tradier API errors
- [ ] Monitor cycle completes in < 30 seconds
- [ ] All managed trades are evaluated

### Nice to Have (Non-Blockers)

- [ ] Exit orders improve price (better than market)
- [ ] Monitor cycle completes in < 15 seconds
- [ ] All debug endpoints accessible from UI

---

## Troubleshooting

### Issue: System enters HARD_STOP

**Check:**
1. `GET /debug/system-mode` for last reason
2. Logs for `[system][mode-change]` entries
3. `emergency_exit_count_today` value

**If false positive:**
- Reset via `POST /debug/system-mode`
- Investigate why emergency exits were triggered
- Adjust logic if needed

### Issue: Exit orders not submitting

**Check:**
1. Market hours (orders won't submit after hours)
2. Tradier API connectivity
3. Order rejection reasons in logs

**If market closed:**
- Expected behavior - orders will be rejected
- Should see `[exit][order][rejected]` with `benign: true`

### Issue: Trades stuck in CLOSING_PENDING

**Check:**
1. Order status in Tradier
2. Order sync logs
3. Polling logic in `pollForExitFill()`

**Action:**
- Manually check order in Tradier
- May need to manually close if order failed

---

## Quick Reference

```bash
# System state
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/system-mode

# Exit rules
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/exit-rules

# Run monitor
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/monitor

# Force exit
curl -X POST https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/force-exit/{trade-id}

# System status
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/status

# Reset system mode (if needed)
curl -X POST https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/system-mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "NORMAL", "reason": "manual_reset"}'
```

---

## Next Steps After Success

1. **Tune exit rule thresholds** based on live performance
2. **Increase position sizing** gradually
3. **Monitor exit execution quality** (slippage, fill rates)
4. **Optimize monitor cycle timing** if needed
5. **Add more sophisticated exit rules** (e.g., volatility-based)

---

## Go/No-Go Decision

**If all "Must Pass" criteria pass → Phase 2 is ✅ GO for production use**

**If any "Must Pass" criteria fail → Phase 2 is ❌ NO-GO, fix issues before proceeding**

