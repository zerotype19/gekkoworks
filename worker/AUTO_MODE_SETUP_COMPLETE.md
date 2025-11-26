# Auto Mode Setup Complete ✅

**Date:** 2025-11-24  
**Status:** Ready for Phase 2 Auto-Mode Testing

---

## ✅ All 6 Tasks Implemented

### **Task 1: Auto Mode Gates for PAPER/LIVE** ✅
- **Settings Added:**
  - `AUTO_MODE_ENABLED_PAPER` (default: `false`)
  - `AUTO_MODE_ENABLED_LIVE` (default: `false`)
  - `MIN_SCORE_PAPER` (default: `90`)
  - `MIN_SCORE_LIVE` (default: `95`)

- **Implementation:**
  - Auto mode checked in `entry.ts` before order placement
  - Mode-specific gates: PAPER uses `AUTO_MODE_ENABLED_PAPER`, LIVE uses `AUTO_MODE_ENABLED_LIVE`
  - Score threshold enforced: proposals must score ≥ `MIN_SCORE_PAPER` (90) or `MIN_SCORE_LIVE` (95)
  - Logging: `[auto][skip]` logs when auto mode disabled or score too low

- **No Relaxed Thresholds:**
  - Removed all relaxed score logic for PAPER mode
  - Same strict criteria for all modes
  - Only difference: score thresholds (90 for PAPER, 95 for LIVE)

---

### **Task 2: Normal Scoring Restored** ✅
- **Single Score Gate:**
  - Only one scoring gate active: `proposal.score >= minScore`
  - No secondary paths or hidden overrides
  - No time-of-day adjustments
  - No trade-count-based relaxations

- **Debug Endpoint:**
  - `GET /v2/debug/auto-config` shows:
    - Current `envMode`
    - `AUTO_MODE_ENABLED_PAPER` / `AUTO_MODE_ENABLED_LIVE`
    - `MIN_SCORE_PAPER` / `MIN_SCORE_LIVE`
    - Current effective threshold

---

### **Task 3: Trailing Profit Exit** ✅
- **Configuration:**
  - `CLOSE_RULE_TRAIL_ARM_PROFIT_FRACTION` (default: `0.25` = +25%)
  - `CLOSE_RULE_TRAIL_GIVEBACK_FRACTION` (default: `0.10` = 10 percentage points)

- **Logic:**
  - Tracks `max_seen_profit_fraction` for each trade
  - Arms trailing once peak ≥ +25%
  - Triggers exit if giveback ≥ 10% from peak
  - Example: Peak at +32%, drops to +20% → exit triggered (12% giveback)

- **Order of Evaluation:**
  1. Emergency / Structural break
  2. Time exit (DTE ≤ 2 AND time ≥ 15:50 ET)
  3. **Trailing profit** (NEW)
  4. Hard profit target (+35%)
  5. Stop loss (-30%)

- **Logging:**
  - `[monitor][exit][trail][armed]` when trail arms
  - `[monitor][exit][trail][triggered]` when exit triggered

---

### **Task 4: Stop Loss at -30%** ✅
- **Configuration:**
  - `CLOSE_RULE_STOP_LOSS_FRACTION` = `-0.30` (-30% of max loss)
  - **No deep bleed allowed** - confirmed no -50% or other thresholds

- **Enforcement:**
  - Exit triggered when `pnl_fraction <= -0.30`
  - Logged as `[monitor][exit][triggered] reason=STOP_LOSS`

---

### **Task 5: Exposure Caps** ✅
- **Configuration:**
  - `MAX_OPEN_SPREADS_GLOBAL` (default: `10`)
  - `MAX_OPEN_SPREADS_PER_SYMBOL` (default: `5`)
  - `MAX_NEW_TRADES_PER_DAY` (default: `5`)

- **Enforcement:**
  - Checked in `entry.ts` before order placement
  - Logged as `[auto][skip] exposure limit hit` if any cap violated
  - Prevents opening new trades if limits reached

---

### **Task 6: Pre-Open Readiness Check** ✅
- **Debug Endpoint:**
  - `GET /v2/debug/auto-readiness`
  - Returns:
    - `ready`: Overall readiness status
    - `envMode`: Current trading mode
    - `autoMode.enabled`: Is auto mode enabled?
    - `autoMode.minScore`: Current score threshold
    - `exposure`: Current counts vs limits
    - `risk.flags`: Any risk flags (HARD_STOP, emergency exits, sync failures)
    - `sync`: Sync freshness status

---

## 📋 Pre-Market Checklist for Tomorrow

### **Before Market Open:**

1. **Check Auto Config:**
   ```bash
   curl https://gekkoworks-api.kevin-mcgovern.workers.dev/v2/debug/auto-config
   ```
   - Verify: `envMode: "SANDBOX_PAPER"`
   - Verify: `autoMode.paper: false` (initially)
   - Verify: `scoreThresholds.paper: 90`

2. **Check Auto Readiness:**
   ```bash
   curl https://gekkoworks-api.kevin-mcgovern.workers.dev/v2/debug/auto-readiness
   ```
   - Verify: `ready: false` (until you enable auto mode)
   - Verify: `risk.flags.hardStop: false`
   - Verify: `risk.flags.emergencyExits: false`
   - Verify: `risk.flags.syncFailures: false` (after sync runs)

3. **Enable Auto Mode (When Ready):**
   - Set `AUTO_MODE_ENABLED_PAPER = true` in settings
   - Re-check `/v2/debug/auto-readiness` - should show `ready: true`

---

## 🎯 What Happens When Auto Mode is ON

### **Proposal → Trade Flow:**
1. Proposal generated (every 15 min during RTH)
2. Proposal must score ≥ 90 (PAPER) or 95 (LIVE)
3. Exposure caps checked (global, per-symbol, daily)
4. Auto mode gate checked (`AUTO_MODE_ENABLED_PAPER` must be `true`)
5. If all pass → order placed automatically
6. Order polled until filled (30s timeout, 2s interval)
7. Trade marked OPEN after fill

### **Monitor → Exit Flow:**
1. Monitor cycle runs every minute
2. For each open trade:
   - Update `max_seen_profit_fraction` if PnL increased
   - Check exit rules in priority order:
     - Emergency / Structural break
     - Time exit (DTE ≤ 2 AND time ≥ 15:50 ET)
     - **Trailing profit** (if armed and giveback ≥ 10%)
     - Hard profit target (+35%)
     - Stop loss (-30%)
3. If exit triggered → order placed automatically
4. Trade marked CLOSED after fill

---

## 📊 Current System State

- **Auto Mode:** OFF (ready to enable)
- **Score Threshold:** 90 (PAPER)
- **Exposure Caps:** 10 global, 5 per symbol, 5 per day
- **Stop Loss:** -30% (confirmed)
- **Trailing Profit:** Armed at +25%, exits on 10% giveback
- **Hard Profit Target:** +35%

---

## 🚀 Ready for Tomorrow

The system is now configured for:
- ✅ High-quality entries (score ≥ 90)
- ✅ Aggressive profit-taking (trailing + hard target)
- ✅ Tight loss control (-30% stop)
- ✅ Exposure limits (caps enforced)
- ✅ Auto mode gates (PAPER/LIVE separation)

**Next Step:** Enable `AUTO_MODE_ENABLED_PAPER = true` when ready to begin auto trading.

