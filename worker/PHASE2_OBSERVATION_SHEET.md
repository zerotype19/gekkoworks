# Phase 2 Observation Sheet

**Date:** _______________  
**Session:** Morning / Afternoon / Full Day  
**Market Status:** Open / Closed  
**Auto Mode:** OFF (Supervised)

---

## Pre-Market Check (Before 9:30 AM ET)

- [ ] `/v2/debug/health` shows `system_mode: NORMAL`
- [ ] `/v2/debug/health` shows `risk_state: NORMAL`
- [ ] `/v2/debug/health` shows `emergency_exit_count_today: 0`
- [ ] `/v2/debug/health` shows all spreads valid (16/16)
- [ ] `/status` shows `trading_mode: SANDBOX_PAPER`
- [ ] `/status` shows `market_hours: true` (after 9:30 AM ET)
- [ ] Sync timestamps are recent (< 5 minutes old)

---

## Proposal Generation (Every 15 Minutes During RTH)

### First Proposal Cycle (9:30-9:45 AM ET)

- [ ] Proposal generated: YES / NO
- [ ] If YES:
  - [ ] Delta in range: -0.30 to -0.20
  - [ ] DTE in range: 30-35 days
  - [ ] Credit ≥ $1.00
  - [ ] Score meets minimum threshold
  - [ ] Portfolio net credit rule passed
  - [ ] No stale quote warnings
- [ ] If NO:
  - [ ] Reason logged: _______________
  - [ ] Market conditions: _______________

### Subsequent Proposal Cycles

| Time | Proposal? | Delta | DTE | Credit | Notes |
|------|-----------|-------|-----|--------|-------|
| 9:45-10:00 | | | | | |
| 10:00-10:15 | | | | | |
| 10:15-10:30 | | | | | |
| 10:30-10:45 | | | | | |
| 10:45-11:00 | | | | | |
| 11:00-11:15 | | | | | |
| 11:15-11:30 | | | | | |
| 11:30-11:45 | | | | | |
| 11:45-12:00 | | | | | |
| 12:00-12:15 | | | | | |
| 12:15-12:30 | | | | | |
| 12:30-12:45 | | | | | |
| 12:45-13:00 | | | | | |
| 13:00-13:15 | | | | | |
| 13:15-13:30 | | | | | |
| 13:30-13:45 | | | | | |
| 13:45-14:00 | | | | | |
| 14:00-14:15 | | | | | |
| 14:15-14:30 | | | | | |
| 14:30-14:45 | | | | | |
| 14:45-15:00 | | | | | |
| 15:00-15:15 | | | | | |
| 15:15-15:30 | | | | | |
| 15:30-15:45 | | | | | |
| 15:45-16:00 | | | | | |

---

## Monitor Cycle (Every 1 Minute During RTH)

### Exit Signal Logs

Watch for: `[monitor][exit][triggered]`

| Time | Trade ID | Exit Reason | PnL % | DTE | Notes |
|------|----------|-------------|-------|-----|-------|
| | | | | | |
| | | | | | |
| | | | | | |

### Exit Reasons to Watch For:

- [ ] `PROFIT_TARGET` - Expected at +35% to +40%
- [ ] `STOP_LOSS` - Expected at -30%
- [ ] `TIME_EXIT` - Expected at DTE ≤ 2 AND time ≥ 15:50 ET
- [ ] `IV_CRUSH` - Expected if IV ≤ 85% of entry AND PnL ≥ +15%
- [ ] `STRUCTURAL_BREAK` - **RED FLAG** - Investigate immediately
- [ ] `EMERGENCY` - **RED FLAG** - Investigate immediately

---

## Sync Health (Check Every Hour)

| Time | Positions Sync | Orders Sync | Balances Sync | Notes |
|------|----------------|-------------|---------------|-------|
| 10:00 | | | | |
| 11:00 | | | | |
| 12:00 | | | | |
| 13:00 | | | | |
| 14:00 | | | | |
| 15:00 | | | | |
| 16:00 | | | | |

**Sync Status:**
- ✅ = Success, < 2 min old
- ⚠️ = Success, but > 5 min old
- ❌ = Failed

---

## Red Flags Log

| Time | Issue | Severity | Action Taken | Resolved? |
|------|-------|----------|--------------|-----------|
| | | | | |
| | | | | |
| | | | | |

**Severity Levels:**
- 🔴 **CRITICAL** - Stop trading immediately
- 🟡 **WARNING** - Monitor closely, may need intervention
- 🟢 **INFO** - Note for review, no action needed

---

## End-of-Day Summary

**Date:** _______________

### Statistics:
- Total proposals generated: ________
- Proposals approved: ________
- Proposals rejected: ________
- Exit signals triggered: ________
- Exits executed: ________
- Emergency exits: ________ (should be 0)

### Issues Found:
1. _______________
2. _______________
3. _______________

### System Health:
- [ ] No emergency exits
- [ ] No sync failures
- [ ] No structural breaks
- [ ] All spreads valid
- [ ] Reconcile clean

### Notes:
_______________
_______________
_______________

---

## Next Session Plan

- [ ] Review logs from today
- [ ] Address any issues found
- [ ] Adjust thresholds if needed
- [ ] Continue Phase 2 testing

