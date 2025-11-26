# Phase 2 Market Open Test Plan

**Purpose:** Validate system behavior with live market data during the first trading session.

**Duration:** Full trading day (9:30 AM - 4:00 PM ET)

**Mode:** Supervised PAPER (auto_mode = OFF)

---

## Pre-Market Setup (8:00 - 9:30 AM ET)

### 1. System Health Check

```bash
# Check system status
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/status

# Verify health endpoint
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/v2/debug/health

# Verify reconciliation
curl "https://gekkoworks-api.kevin-mcgovern.workers.dev/v2/admin/reconcile?autoRepair=false"
```

**Expected Results:**
- ✅ `system_mode: NORMAL`
- ✅ `risk_state: NORMAL`
- ✅ `emergency_exit_count_today: 0`
- ✅ All 16 spreads valid
- ✅ No reconciliation mismatches
- ✅ Sync timestamps recent

### 2. Verify Cron Schedules

Confirm in Cloudflare dashboard:
- ✅ Premarket cron fired at 8:00 AM ET
- ✅ Trade cycle cron scheduled for 9:30 AM ET
- ✅ Monitor cycle cron scheduled for 9:31 AM ET

### 3. Manual Test Runs

```bash
# Test proposal generation (should return null if market closed)
curl -X POST https://gekkoworks-api.kevin-mcgovern.workers.dev/test/proposal

# Test monitor cycle
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/monitor

# Test portfolio sync
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/portfolio-sync
```

---

## Market Open (9:30 AM ET)

### Test 1: First Proposal Cycle (9:30 - 9:45 AM ET)

**Objective:** Verify proposal generation works with live market data

**Steps:**
1. Wait for first trade cycle cron (9:30 AM ET)
2. Check logs for proposal generation
3. Verify proposal meets all criteria

**Expected Logs:**
```
[proposal] cycle_start
[proposal] eligible_expirations
[proposal] candidate_scored
[proposal] proposal_created
```

**Validation Checklist:**
- [ ] Proposal generated within 15 minutes of market open
- [ ] Delta in range: -0.30 to -0.20
- [ ] DTE in range: 30-35 days
- [ ] Credit ≥ $1.00
- [ ] Score ≥ minimum threshold
- [ ] Portfolio net credit rule passed
- [ ] No stale quote warnings
- [ ] Sync completed before proposal

**If Proposal Generated:**
- [ ] Review proposal details
- [ ] Manually approve/reject
- [ ] If approved, watch for order placement
- [ ] Verify order appears in Tradier

**If No Proposal:**
- [ ] Check logs for reason
- [ ] Verify market conditions
- [ ] Check if all filters passed

---

### Test 2: Monitor Cycle (9:31 AM ET - Ongoing)

**Objective:** Verify monitoring evaluates open trades correctly

**Steps:**
1. Monitor logs every minute
2. Watch for exit signal evaluations
3. Verify P&L calculations

**Expected Logs (Every Minute):**
```
[monitor] heartbeat
[monitor] cycle_start
[monitor] open_trades_scan
[monitor][trade] evaluating
[data][tradier][quotes]
[data][tradier][chains]
[monitor][exit][evaluate]
```

**Validation Checklist:**
- [ ] Monitor cycle runs every minute
- [ ] All 16 open trades evaluated
- [ ] P&L calculations use Tradier data
- [ ] DTE calculations correct
- [ ] No emergency exits triggered
- [ ] No structural break false positives
- [ ] Exit rules evaluate correctly

**Watch For:**
- 🔴 Emergency exits (should be 0)
- 🔴 Structural breaks (should be 0)
- 🟡 Exit signals (expected if conditions met)
- 🟢 Normal evaluation (most common)

---

### Test 3: Sync Subsystem (Ongoing)

**Objective:** Verify Tradier-first sync works correctly

**Steps:**
1. Check sync timestamps every hour
2. Verify positions/orders/balances stay in sync
3. Run reconciliation checks

**Validation Checklist:**
- [ ] Positions sync updates every monitor cycle
- [ ] Orders sync updates after order placement
- [ ] Balances sync updates regularly
- [ ] Sync timestamps < 2 minutes old
- [ ] No sync failures in logs
- [ ] Reconciliation shows no mismatches

**Test Reconciliation:**
```bash
# Check-only reconciliation
curl "https://gekkoworks-api.kevin-mcgovern.workers.dev/v2/admin/reconcile?autoRepair=false"

# Should show:
# - mismatches_found: 0
# - All trades matched
```

---

### Test 4: Exit Signal Evaluation (When Conditions Met)

**Objective:** Verify exit rules trigger correctly

**Triggers to Test:**
1. **Profit Target** (+35% to +40%)
   - Monitor a trade approaching profit target
   - Verify exit signal triggers at correct threshold
   - Manually approve exit

2. **Stop Loss** (-30%)
   - Monitor a trade approaching stop loss
   - Verify exit signal triggers at correct threshold
   - Manually approve exit

3. **Time Exit** (DTE ≤ 2 AND time ≥ 15:50 ET)
   - Monitor trades approaching expiration
   - Verify exit signal triggers at correct time
   - Manually approve exit

4. **IV Crush** (IV ≤ 85% of entry AND PnL ≥ +15%)
   - Monitor IV changes
   - Verify exit signal triggers when conditions met
   - Manually approve exit

**Validation Checklist:**
- [ ] Exit signals trigger at correct thresholds
- [ ] Exit orders placed correctly
- [ ] Exit orders filled in Tradier
- [ ] Trades marked CLOSED in D1
- [ ] P&L calculated correctly
- [ ] No false triggers

---

### Test 5: Error Handling

**Objective:** Verify system handles errors gracefully

**Scenarios to Monitor:**
1. **Stale Quotes**
   - System should skip proposal/monitor if quotes stale
   - Should log warning, not crash

2. **After-Hours Rejections**
   - If order placed after hours, should log as benign
   - Should not trigger emergency exit

3. **Sync Failures**
   - If sync fails, should abort cycle
   - Should log error clearly
   - Should not proceed with stale data

4. **Missing Data**
   - If entry_price missing, should skip P&L-based exits
   - Should still check structural integrity

**Validation Checklist:**
- [ ] Errors logged clearly
- [ ] System continues operating after errors
- [ ] No crashes or unhandled exceptions
- [ ] Emergency exits not triggered by benign errors

---

## End-of-Day Validation (4:00 PM ET)

### Final Checks

```bash
# System status
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/status

# Health check
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/v2/debug/health

# Reconciliation
curl "https://gekkoworks-api.kevin-mcgovern.workers.dev/v2/admin/reconcile?autoRepair=false"

# Portfolio sync
curl https://gekkoworks-api.kevin-mcgovern.workers.dev/debug/portfolio-sync
```

**Expected Results:**
- ✅ `system_mode: NORMAL`
- ✅ `risk_state: NORMAL`
- ✅ `emergency_exit_count_today: 0`
- ✅ All spreads valid
- ✅ No reconciliation mismatches
- ✅ Sync timestamps recent

### Summary Report

**Fill out:**
- Total proposals generated: ________
- Proposals approved: ________
- Exit signals triggered: ________
- Exits executed: ________
- Emergency exits: ________ (should be 0)
- Sync failures: ________ (should be 0)
- Issues found: ________

---

## Success Criteria

**Phase 2 passes if:**
- ✅ No emergency exits during market hours
- ✅ No sync failures
- ✅ No structural break false positives
- ✅ Proposals generated correctly
- ✅ Exit rules evaluate correctly
- ✅ All trades remain valid
- ✅ Reconciliation clean

**If any red flags:**
- 🔴 Pause testing
- 🔴 Investigate root cause
- 🔴 Fix issue
- 🔴 Resume testing

---

## Next Steps

If Phase 2 passes:
- ✅ Continue supervised testing for 1-2 more sessions
- ✅ Begin Phase 3 implementation
- ✅ Prepare for auto-mode enablement

If Phase 2 fails:
- ❌ Document issues
- ❌ Fix root causes
- ❌ Re-test before proceeding

