# 🚀 Auto-Mode Morning Checklist

**Use this checklist every morning before market open (9:30 ET) to verify system readiness.**

---

## ✅ Pre-Market Checks (Before 9:30 ET)

### 1. Auto-Config Verification
**Endpoint:** `/v2/debug/auto-config`

**Expected Values:**
- `autoMode.enabled: true`
- `autoMode.paper: true`
- `autoMode.live: false`
- `scoreThresholds.paper: 90`
- `scoreThresholds.live: 95`
- `envMode: "SANDBOX_PAPER"`

**Action if wrong:** Check settings table, ensure `AUTO_MODE_ENABLED_PAPER = true`

---

### 2. Auto-Readiness Check
**Endpoint:** `/v2/debug/auto-readiness`

**Expected Values:**
- `autoModeEnabled: true`
- `systemMode: "NORMAL"` (not HARD_STOP)
- `riskState: "NORMAL"`
- `emergencyExitsToday: 0`
- `syncFreshness.positions: < 120 seconds`
- `syncFreshness.orders: < 120 seconds`
- `syncFreshness.balances: < 120 seconds`
- `exposureCounts.openSpreadsGlobal: ≤ 10`
- `exposureCounts.openSpreadsPerSymbol: ≤ 5`
- `exposureCounts.newTradesToday: ≤ 5`

**Action if wrong:**
- If `systemMode: "HARD_STOP"` → Investigate via `/risk-state`
- If sync stale → Run `/debug/portfolio-sync`
- If exposure limits hit → Review open positions

---

### 3. Tradier Sync Verification
**Endpoint:** `/v2/debug/portfolio-sync`

**Check:**
- Positions in Tradier match positions in D1
- No orphaned trades
- Quantities match
- Entry prices populated

**Action if mismatch:** Run `/v2/admin/reconcile?autoRepair=true`

---

### 4. Risk State Check
**Endpoint:** `/risk-state`

**Expected:**
- `SYSTEM_MODE: "NORMAL"`
- `RISK_STATE: "NORMAL"`
- `EMERGENCY_EXIT_COUNT_TODAY: 0`
- `DAILY_STOP_HIT: false`

**Action if wrong:** Review logs, investigate emergency exits

---

## 🎯 Entry Behavior (Auto-Mode Active)

Trades will **auto-enter** when:

✅ Proposal score ≥ 90  
✅ DTE 30–35  
✅ Delta –0.20 to –0.30  
✅ Min credit $1.00  
✅ Portfolio net credit stays positive  
✅ Exposure caps not exceeded:
  - Global: ≤ 10 open spreads
  - Per symbol: ≤ 5 open spreads
  - Daily: ≤ 5 new trades
✅ Sync freshness < 120 seconds  
✅ Price drift check passes  
✅ Quotes < 90 seconds old  
✅ Market is open  
✅ No risk flags  

---

## 🟦 Exit Behavior (Auto-Mode Active)

Trades will **auto-close** when:

🟢 **Trailing Profit Exit**
- Peak profit ≥ +25% → armed
- Gives back 10 percentage points → exit
- Example: Hits +30%, drops to +20% → exit

🎯 **Hard Profit Target**
- Profit ≥ +35% of max gain

🔻 **Stop Loss**
- Loss ≥ –30% of max loss

⏰ **Time Exit**
- DTE ≤ 2 AND time ≥ 15:50 ET

🚨 **Emergency Exit**
- Structural break detected
- Sync break detected
- System instability

---

## 📊 Monitoring During Market Hours

### Key Endpoints to Monitor

1. **System Health:** `/v2/debug/health`
   - Check every hour during market hours
   - Verify sync freshness
   - Check engine heartbeat

2. **Auto-Readiness:** `/v2/debug/auto-readiness`
   - Monitor exposure counts
   - Watch for risk flags

3. **Risk State:** `/risk-state`
   - Monitor for emergency exits
   - Watch for HARD_STOP triggers

4. **Portfolio Sync:** `/v2/debug/portfolio-sync`
   - Verify positions aligned
   - Check entry prices populated

---

## 🚨 Emergency Procedures

### If System Enters HARD_STOP Mode

1. **Check Risk State:** `/risk-state`
   - Review `EMERGENCY_EXIT_COUNT_TODAY`
   - Check `DAILY_STOP_HIT` flag

2. **Review Logs:**
   - Check Cloudflare Worker logs
   - Look for emergency exit triggers
   - Verify if false positives

3. **Investigate:**
   - Check if after-hours rejections triggered false positives
   - Verify if missing entry_price caused issues
   - Review structural integrity checks

4. **Safe Reset (if needed):**
   - Use `/test/reset-risk-state` (only resets flags, doesn't close trades)
   - Verify trades still open in Tradier
   - Re-run auto-readiness check

---

## 📝 Daily Post-Market Review

After market close, review:

1. **Trades Opened Today**
   - Count matches expectations
   - All have valid entry prices
   - Quantities correct

2. **Trades Closed Today**
   - Exit reasons logged
   - P&L calculated correctly
   - Realized P&L matches Tradier

3. **Sync Status**
   - All positions synced
   - All orders synced
   - Balances updated

4. **Risk Metrics**
   - Emergency exits (should be 0)
   - System mode (should be NORMAL)
   - Exposure counts (within limits)

---

## 🔗 Quick Links

All available in Dashboard UI (click "Show Debug Tools"):

- **System Status & Health**
  - System Status
  - System Health (v2)
  - Auto Mode Config
  - Auto Mode Readiness
  - Risk State
  - Exit Rules Config

- **Manual Operations**
  - Run Monitor Cycle
  - System Mode
  - Broker Events

- **Tradier-First Tools**
  - Reconcile (Check Only)
  - Reconcile (Auto-Repair)
  - Portfolio Sync
  - Migrate (One-Time)

---

## ✅ Go/No-Go Decision

**GO if:**
- ✅ All pre-market checks pass
- ✅ Auto-mode enabled for PAPER
- ✅ Score threshold = 90
- ✅ System mode = NORMAL
- ✅ Risk state = NORMAL
- ✅ Sync freshness < 120s
- ✅ Exposure counts within limits
- ✅ No emergency exits today

**NO-GO if:**
- ❌ System mode = HARD_STOP
- ❌ Risk state ≠ NORMAL
- ❌ Sync stale (> 120s)
- ❌ Emergency exits > 0
- ❌ Exposure limits exceeded
- ❌ Tradier sync mismatch

---

**Last Updated:** 2025-11-24  
**Auto-Mode Status:** ✅ ACTIVE (PAPER only)  
**Score Threshold:** 90  
**System State:** Ready for supervised auto-trading

