# Phase 2 "Go / No-Go" Checklist

**Purpose:** Determine if Phase 2 exit integrity is ready for aggressive auto-mode testing.

**Prerequisites:** All items in `PHASE2_VERIFICATION_CHECKLIST.md` must pass.

---

## Pre-Flight: Closed-Market Tests (Must Pass)

### ✅ Exit Rules Config
- [ ] All 7 exit rules loaded from DB
- [ ] No hardcoded values in exit evaluation code
- [ ] Config changes reflect in `/debug/exit-rules` endpoint

### ✅ Monitor Cycle
- [ ] `GET /debug/monitor` runs without errors
- [ ] All OPEN trades are evaluated every cycle
- [ ] Fresh quotes are fetched from Tradier
- [ ] Logs show proper `[monitor][start]`, `[monitor][trade]`, `[close] decision` patterns

### ✅ Exit Pipeline
- [ ] `POST /debug/test-close-position` successfully closes a position
- [ ] `POST /debug/force-exit/:tradeId` works for any OPEN trade
- [ ] Exit orders are submitted to Tradier (in SANDBOX_PAPER mode)
- [ ] Trade status transitions correctly: `OPEN → CLOSING_PENDING → CLOSED`
- [ ] `realized_pnl` is calculated and stored

### ✅ Data Integrity
- [ ] Missing quote data triggers `[data][missing-field]` logs
- [ ] No fake/placeholder values used in calculations
- [ ] System gracefully handles missing data (no crashes)

### ✅ Error Handling
- [ ] All errors logged with consistent tags: `[monitor][error]`, `[exit][error]`, `[data][error]`
- [ ] No silent failures
- [ ] DB errors are caught and logged

---

## Live-Market Validation (Required Before Go)

### Test 1: Real-Time Quote Freshness

**Setup:**
- [ ] Markets are open
- [ ] At least one OPEN trade exists

**Test:**
1. [ ] Call `GET /debug/monitor`
2. [ ] Check logs for `[data][freshness]` entries
3. [ ] Verify `quote_age_ms: 0` (quotes just fetched)
4. [ ] Verify quotes match current market prices (spot check)

**✅ Pass:** Quotes are fresh, no stale data used

---

### Test 2: Exit Rule Thresholds Work

**Setup:**
1. [ ] Set tight test thresholds:
   ```sql
   UPDATE settings SET value = '0.05' WHERE key = 'CLOSE_RULE_PROFIT_TARGET_FRACTION';
   UPDATE settings SET value = '-0.05' WHERE key = 'CLOSE_RULE_STOP_LOSS_FRACTION';
   ```
2. [ ] Open a small PAPER trade (or use existing one)

**Test:**
1. [ ] Monitor logs during market hours
2. [ ] When P&L crosses threshold, verify:
   - [ ] `[monitor][exit-signal]` appears
   - [ ] `[exit][order][sent]` appears in same cycle
   - [ ] Exit order is submitted to Tradier
   - [ ] Trade closes with correct `realized_pnl`

**✅ Pass:** Exit rules trigger correctly based on live P&L

---

### Test 3: Time-Based Exit Works

**Setup:**
1. [ ] Find a trade with DTE ≤ 2 (or temporarily set `CLOSE_RULE_TIME_EXIT_DTE = 999`)
2. [ ] Set `CLOSE_RULE_TIME_EXIT_DTE = 0` to force time exit

**Test:**
1. [ ] Call `GET /debug/monitor`
2. [ ] Verify `[monitor][exit-signal]` with `trigger: TIME_EXIT`
3. [ ] Verify exit order is submitted

**✅ Pass:** Time-based exits work correctly

---

### Test 4: Full Lifecycle (Entry → Monitor → Exit)

**Test:**
1. [ ] System opens a new trade via normal flow
2. [ ] Trade appears in `OPEN` status
3. [ ] Monitor cycle evaluates it (see `[monitor][trade]` logs)
4. [ ] When exit condition met, trade closes automatically
5. [ ] Verify in Tradier that position is closed
6. [ ] Verify in DB that `realized_pnl` is correct

**✅ Pass:** Complete lifecycle works end-to-end

---

## Go Criteria (All Must Pass)

### Must-Have (Blockers)
- [ ] ✅ All closed-market tests pass
- [ ] ✅ Real-time quotes are fresh (no stale data)
- [ ] ✅ Exit rules trigger correctly based on live P&L
- [ ] ✅ Exit orders are submitted to Tradier successfully
- [ ] ✅ Trade status transitions work correctly
- [ ] ✅ `realized_pnl` is calculated correctly
- [ ] ✅ No crashes or silent failures
- [ ] ✅ All errors are logged with proper tags

### Should-Have (Warnings)
- [ ] Exit orders fill within expected timeframe
- [ ] Monitor cycle runs every minute without gaps
- [ ] DB health check shows all systems operational
- [ ] No excessive Tradier API errors

### Nice-to-Have (Non-Blockers)
- [ ] Exit orders improve price (better than market)
- [ ] Monitor cycle completes in < 30 seconds
- [ ] All debug endpoints accessible from UI

---

## No-Go Criteria (Any One Blocks)

### Critical Blockers
- [ ] ❌ Exit orders fail to submit to Tradier
- [ ] ❌ Trade status doesn't update after exit
- [ ] ❌ `realized_pnl` is incorrect or missing
- [ ] ❌ System crashes during monitor cycle
- [ ] ❌ Hardcoded values still exist in exit logic
- [ ] ❌ Missing data causes fake P&L calculations
- [ ] ❌ Exit rules don't trigger when thresholds are met

### Warning Signs (Investigate Before Go)
- [ ] Exit orders frequently rejected by Tradier
- [ ] Monitor cycle takes > 60 seconds
- [ ] Frequent `[data][missing-field]` logs
- [ ] Trade status gets stuck in `CLOSING_PENDING`

---

## Decision Matrix

| Scenario | Decision | Action |
|----------|----------|--------|
| All Must-Have pass | ✅ **GO** | Proceed to aggressive auto-mode testing |
| Any Critical Blocker | ❌ **NO-GO** | Fix blocker, retest |
| Warnings but no blockers | ⚠️ **GO WITH CAUTION** | Monitor closely, fix warnings in parallel |

---

## Post-Go Monitoring

Once Phase 2 is marked ✅ GO:

1. **First 24 hours:**
   - Monitor logs every hour
   - Verify all exits execute correctly
   - Check `realized_pnl` accuracy

2. **First week:**
   - Daily review of exit performance
   - Verify no regressions
   - Tune exit rule thresholds if needed

3. **Ongoing:**
   - Weekly review of exit rule effectiveness
   - Monitor for any new error patterns
   - Keep debug endpoints available for troubleshooting

---

## Quick Test Commands

```bash
# Check exit rules
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/exit-rules

# Run monitor cycle
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/monitor

# Force exit a trade
curl -X POST https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/force-exit/{trade-id}

# Test close position
curl -X POST https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/test-close-position

# Check system status
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/status

# DB health check
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/health/db
```

---

## Next Steps After Go

1. **Tune exit rule thresholds** based on live performance
2. **Increase position sizing** gradually
3. **Monitor exit execution quality** (slippage, fill rates)
4. **Optimize monitor cycle timing** if needed
5. **Add more sophisticated exit rules** (e.g., volatility-based)

